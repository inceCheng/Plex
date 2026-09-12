use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const PROVIDER_KEYCHAIN_SERVICE: &str = "com.plex.desktop.provider";
const MODELS_DEV_URL: &str = "https://models.dev/api.json";

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
}

struct SidecarState {
    process: Mutex<Option<SidecarProcess>>,
    running: Mutex<Arc<AtomicBool>>,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            running: Mutex::new(Arc::new(AtomicBool::new(false))),
        }
    }
}

impl SidecarState {
    fn is_running(&self) -> bool {
        self.running
            .lock()
            .map(|flag| flag.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    fn install_running_flag(&self, flag: Arc<AtomicBool>) {
        if let Ok(mut guard) = self.running.lock() {
            *guard = flag;
        }
    }
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        if let Ok(flag) = self.running.lock() {
            flag.store(false, Ordering::SeqCst);
        }
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut process) = guard.take() {
                let _ = process.child.kill();
                let _ = process.child.wait();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarStatus {
    running: bool,
    api_key_configured: bool,
    database_path: String,
    sidecar_command: String,
}

#[cfg(target_os = "macos")]
fn keychain_key(service: &str, account: &str) -> Option<String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            service,
            "-a",
            account,
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let key = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_key(_service: &str, _account: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn write_keychain_key(service: &str, account: &str, key: &str) -> Result<(), String> {
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            account,
            "-w",
            key,
        ])
        .status()
        .map_err(|error| format!("无法调用 macOS 钥匙串：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("写入 macOS 钥匙串失败".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_keychain_key(_service: &str, _account: &str, _key: &str) -> Result<(), String> {
    Err("当前平台尚未实现钥匙串写入，请使用环境变量".to_string())
}

#[cfg(target_os = "macos")]
fn delete_keychain_key(service: &str, account: &str) -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            service,
            "-a",
            account,
        ])
        .output()
        .map_err(|error| format!("无法调用 macOS 钥匙串：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found")
        || stderr.contains("The specified item could not be found")
    {
        Ok(())
    } else {
        Err(format!("删除 macOS 钥匙串条目失败：{stderr}"))
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_keychain_key(_service: &str, _account: &str) -> Result<(), String> {
    Ok(())
}

fn configured_api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| keychain_key(PROVIDER_KEYCHAIN_SERVICE, "openai"))
        .or_else(|| keychain_key("com.plex.desktop.openai", "default"))
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn host_triple() -> String {
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        other => other,
    };
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        other => format!("{arch}-{other}"),
    }
}

struct SidecarCommandSpec {
    command: Command,
    description: String,
}

fn sidecar_command(app: &AppHandle) -> Result<SidecarCommandSpec, String> {
    let root = project_root();
    let triple = host_triple();

    if let Ok(explicit) = std::env::var("PLEX_SIDECAR_BIN") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            let mut command = Command::new(&path);
            command.current_dir(&root);
            return Ok(SidecarCommandSpec {
                command,
                description: path.display().to_string(),
            });
        }
    }

    let mut candidates = vec![
        root.join("src-tauri")
            .join("binaries")
            .join(format!("plex-agent-{triple}")),
        root.join("src-tauri")
            .join("binaries")
            .join("plex-agent"),
    ];
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join("plex-agent"));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("plex-agent"));
        candidates.push(
            resource_dir
                .join("binaries")
                .join(format!("plex-agent-{triple}")),
        );
    }

    for candidate in candidates {
        if candidate.exists() {
            let mut command = Command::new(&candidate);
            command.current_dir(&root);
            return Ok(SidecarCommandSpec {
                command,
                description: candidate.display().to_string(),
            });
        }
    }

    let bun = std::env::var("PLEX_BUN_BIN").unwrap_or_else(|_| "bun".to_string());
    let script = root.join("sidecar").join("src").join("main.ts");
    let mut command = Command::new(&bun);
    command.arg("run").arg(&script).current_dir(&root);
    Ok(SidecarCommandSpec {
        command,
        description: format!("{bun} run {}", script.display()),
    })
}

fn emit_message(app: &AppHandle, value: Value) {
    let _ = app.emit("sidecar-event", value);
}

fn spawn_line_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    stream: R,
    running: Arc<AtomicBool>,
    ready_sender: Option<mpsc::Sender<Result<(), String>>>,
    log_stream: bool,
) {
    std::thread::spawn(move || {
        let mut ready_sender = ready_sender;
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if log_stream {
                emit_message(
                    &app,
                    serde_json::json!({
                        "type": "log",
                        "level": "error",
                        "message": trimmed,
                    }),
                );
                continue;
            }

            match serde_json::from_str::<Value>(trimmed) {
                Ok(value) => {
                    if value.get("type").and_then(Value::as_str) == Some("status")
                        && value.get("status").and_then(Value::as_str) == Some("ready")
                    {
                        if let Some(sender) = ready_sender.take() {
                            let _ = sender.send(Ok(()));
                        }
                    }
                    emit_message(&app, value);
                }
                Err(error) => {
                    emit_message(
                        &app,
                        serde_json::json!({
                            "type": "log",
                            "level": "error",
                            "message": format!("Sidecar 输出不是合法 JSON：{error}"),
                        }),
                    );
                }
            }
        }
        running.store(false, Ordering::SeqCst);
        if let Some(sender) = ready_sender.take() {
            let _ = sender.send(Err("Sidecar 在就绪前退出".to_string()));
        }
    });
}

fn start_sidecar(app: &AppHandle, state: &SidecarState) -> Result<(), String> {
    stop_sidecar(state);

    let spec = sidecar_command(app)?;
    let mut command = spec.command;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;

    command
        .env("PLEX_DB_PATH", data_dir.join("plex.sqlite"))
        .env("PLEX_SIDECAR_BIN_DESCRIPTION", &spec.description)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(api_key) = configured_api_key() {
        command.env("OPENAI_API_KEY", api_key);
    }
    if let Ok(model) = std::env::var("PLEX_MODEL") {
        command.env("PLEX_MODEL", model);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Sidecar：{error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Sidecar stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Sidecar stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法连接 Sidecar stderr".to_string())?;

    let (ready_sender, ready_receiver) = mpsc::channel();
    let running = Arc::new(AtomicBool::new(true));
    state.install_running_flag(Arc::clone(&running));
    spawn_line_reader(
        app.clone(),
        stdout,
        Arc::clone(&running),
        Some(ready_sender),
        false,
    );
    spawn_line_reader(app.clone(), stderr, Arc::clone(&running), None, true);

    match ready_receiver.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = child.kill();
            running.store(false, Ordering::SeqCst);
            return Err(error);
        }
        Err(_) => {
            let _ = child.kill();
            running.store(false, Ordering::SeqCst);
            return Err("Sidecar 启动超时".to_string());
        }
    }

    let mut guard = state
        .process
        .lock()
        .map_err(|_| "Sidecar 状态锁已损坏".to_string())?;
    *guard = Some(SidecarProcess { child, stdin });
    Ok(())
}

fn stop_sidecar(state: &SidecarState) {
    if let Ok(flag) = state.running.lock() {
        flag.store(false, Ordering::SeqCst);
    }
    let Ok(mut guard) = state.process.lock() else {
        return;
    };
    let Some(mut process) = guard.take() else {
        return;
    };

    let shutdown = serde_json::json!({ "type": "shutdown" }).to_string();
    let _ = writeln!(process.stdin, "{shutdown}");
    let _ = process.stdin.flush();

    let deadline = Instant::now() + Duration::from_millis(800);
    loop {
        match process.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(40));
            }
            _ => break,
        }
    }

    let _ = process.child.kill();
    let _ = process.child.wait();
}

fn ensure_sidecar(app: &AppHandle, state: &SidecarState) -> Result<(), String> {
    if state.is_running() {
        return Ok(());
    }
    start_sidecar(app, state)
}

fn send_sidecar_request(state: &SidecarState, request: &Value) -> Result<(), String> {
    let mut guard = state
        .process
        .lock()
        .map_err(|_| "Sidecar 状态锁已损坏".to_string())?;
    let process = guard
        .as_mut()
        .ok_or_else(|| "Sidecar 尚未启动".to_string())?;
    let line =
        serde_json::to_string(request).map_err(|error| format!("请求序列化失败：{error}"))?;
    writeln!(process.stdin, "{line}").map_err(|error| format!("写入 Sidecar 失败：{error}"))?;
    process
        .stdin
        .flush()
        .map_err(|error| format!("刷新 Sidecar stdin 失败：{error}"))
}

#[tauri::command]
fn sidecar_start(app: AppHandle, state: State<'_, SidecarState>) -> Result<(), String> {
    start_sidecar(&app, state.inner())
}

#[tauri::command]
fn sidecar_stop(state: State<'_, SidecarState>) -> Result<(), String> {
    stop_sidecar(state.inner());
    Ok(())
}

#[tauri::command]
fn sidecar_send(
    app: AppHandle,
    state: State<'_, SidecarState>,
    request: Value,
) -> Result<(), String> {
    ensure_sidecar(&app, state.inner())?;
    send_sidecar_request(state.inner(), &request)
}

#[tauri::command]
fn sidecar_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    let database_path = app
        .path()
        .app_data_dir()
        .map(|path| path.join("plex.sqlite"))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .display()
        .to_string();
    let sidecar_command = sidecar_command(&app)?.description;
    Ok(SidecarStatus {
        running: state.is_running(),
        api_key_configured: configured_api_key().is_some(),
        database_path,
        sidecar_command,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogResponse {
    source: String,
    fetched_at_unix: u64,
    catalog: Value,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn read_cached_catalog(path: &PathBuf) -> Option<CatalogResponse> {
    let text = std::fs::read_to_string(path).ok()?;
    let catalog: Value = serde_json::from_str(&text).ok()?;
    let fetched_at_unix = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Some(CatalogResponse {
        source: "cache".to_string(),
        fetched_at_unix,
        catalog,
    })
}

#[tauri::command]
async fn models_catalog(
    app: AppHandle,
    force_refresh: Option<bool>,
) -> Result<CatalogResponse, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let cache_path = data_dir.join("models.dev.json");
    let force = force_refresh.unwrap_or(false);

    if !force {
        if let Some(cached) = read_cached_catalog(&cache_path) {
            if unix_now().saturating_sub(cached.fetched_at_unix) < 24 * 60 * 60 {
                return Ok(cached);
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("Plex/0.1.0")
        .build()
        .map_err(|error| format!("创建模型目录客户端失败：{error}"))?;

    match client.get(MODELS_DEV_URL).send().await {
        Ok(response) if response.status().is_success() => {
            let text = response
                .text()
                .await
                .map_err(|error| format!("读取 models.dev 响应失败：{error}"))?;
            let catalog: Value = serde_json::from_str(&text)
                .map_err(|error| format!("解析 models.dev 响应失败：{error}"))?;
            std::fs::write(&cache_path, &text)
                .map_err(|error| format!("缓存 models.dev 响应失败：{error}"))?;
            Ok(CatalogResponse {
                source: "network".to_string(),
                fetched_at_unix: unix_now(),
                catalog,
            })
        }
        Ok(response) => {
            if let Some(cached) = read_cached_catalog(&cache_path) {
                Ok(cached)
            } else {
                Err(format!(
                    "models.dev 返回 {}，且本地没有缓存",
                    response.status()
                ))
            }
        }
        Err(error) => {
            if let Some(cached) = read_cached_catalog(&cache_path) {
                Ok(cached)
            } else {
                Err(format!("无法访问 models.dev：{error}"))
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomProviderModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomProviderConfig {
    id: String,
    name: String,
    base_url: String,
    #[serde(default = "default_api_style")]
    api_style: String,
    #[serde(default)]
    models: Vec<CustomProviderModel>,
}

fn default_api_style() -> String {
    "chat_completions".to_string()
}

fn custom_providers_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(data_dir.join("custom-providers.json"))
}

fn read_custom_providers(app: &AppHandle) -> Result<Vec<CustomProviderConfig>, String> {
    read_custom_providers_from_path(&custom_providers_path(app)?)
}

fn read_custom_providers_from_path(
    path: &PathBuf,
) -> Result<Vec<CustomProviderConfig>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("读取自定义供应商失败：{error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析自定义供应商失败：{error}"))
}

fn write_custom_providers(
    app: &AppHandle,
    providers: &[CustomProviderConfig],
) -> Result<(), String> {
    write_custom_providers_to_path(&custom_providers_path(app)?, providers)
}

fn write_custom_providers_to_path(
    path: &PathBuf,
    providers: &[CustomProviderConfig],
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(providers)
        .map_err(|error| format!("序列化自定义供应商失败：{error}"))?;
    std::fs::write(path, text).map_err(|error| format!("写入自定义供应商失败：{error}"))
}

#[tauri::command]
fn list_custom_providers(app: AppHandle) -> Result<Vec<CustomProviderConfig>, String> {
    read_custom_providers(&app)
}

#[tauri::command]
fn save_custom_provider(
    app: AppHandle,
    provider: CustomProviderConfig,
) -> Result<CustomProviderConfig, String> {
    let saved = normalize_custom_provider(provider)?;
    let mut providers = read_custom_providers(&app)?;
    providers.retain(|item| item.id != saved.id);
    providers.push(saved.clone());
    write_custom_providers(&app, &providers)?;
    Ok(saved)
}

fn normalize_custom_provider(
    provider: CustomProviderConfig,
) -> Result<CustomProviderConfig, String> {
    let name = provider.name.trim();
    let base_url = provider.base_url.trim().trim_end_matches('/');
    if name.is_empty() {
        return Err("供应商名称不能为空".to_string());
    }
    if base_url.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("Base URL 需要以 http:// 或 https:// 开头".to_string());
    }
    let id = if provider.id.trim().is_empty() {
        format!("custom:{}", unix_millis())
    } else {
        provider.id.trim().to_string()
    };
    if !id.starts_with("custom:") {
        return Err("自定义供应商 ID 需要以 custom: 开头".to_string());
    }

    Ok(CustomProviderConfig {
        id,
        name: name.to_string(),
        base_url: base_url.to_string(),
        api_style: if provider.api_style == "responses" {
            "responses".to_string()
        } else {
            "chat_completions".to_string()
        },
        models: provider.models,
    })
}

#[tauri::command]
fn delete_custom_provider(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut providers = read_custom_providers(&app)?;
    providers.retain(|item| item.id != provider_id);
    write_custom_providers(&app, &providers)?;
    delete_keychain_key(PROVIDER_KEYCHAIN_SERVICE, provider_id.trim())
}

fn models_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/models") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/models")
    }
}

fn parse_model_list(value: &Value) -> Result<Vec<CustomProviderModel>, String> {
    let items = if let Some(array) = value.as_array() {
        array.clone()
    } else if let Some(array) = value.get("data").and_then(Value::as_array) {
        array.clone()
    } else if let Some(array) = value.get("models").and_then(Value::as_array) {
        array.clone()
    } else {
        return Err("模型列表响应中没有 data 或 models 数组".to_string());
    };

    let mut models = Vec::new();
    for item in items {
        let (id, name) = match item {
            Value::String(id) => (id.clone(), None),
            Value::Object(object) => {
                let id = object
                    .get("id")
                    .or_else(|| object.get("model"))
                    .or_else(|| object.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let Some(id) = id else {
                    continue;
                };
                let name = object
                    .get("name")
                    .or_else(|| object.get("display_name"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                (id, name)
            }
            _ => continue,
        };
        if id.trim().is_empty() {
            continue;
        }
        models.push(CustomProviderModel {
            id,
            name: name.filter(|value| !value.trim().is_empty()),
        });
    }

    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    models.truncate(2000);
    if models.is_empty() {
        return Err("没有解析到可用模型".to_string());
    }
    Ok(models)
}

async fn fetch_provider_models_from_endpoint(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<CustomProviderModel>, String> {
    let url = models_endpoint(base_url);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Base URL 需要以 http:// 或 https:// 开头".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Plex/0.1.0")
        .build()
        .map_err(|error| format!("创建模型列表客户端失败：{error}"))?;

    let mut request = client.get(&url);
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("无法访问 {url}：{error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取模型列表响应失败：{error}"))?;
    if !status.is_success() {
        let summary: String = text.chars().take(300).collect();
        return Err(format!(
            "拉取模型列表失败（HTTP {status}）：{summary}"
        ));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("解析模型列表失败：{error}"))?;
    parse_model_list(&value)
}

#[tauri::command]
async fn fetch_provider_models(
    base_url: String,
    provider_id: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<CustomProviderModel>, String> {
    let key = api_key
        .filter(|value| !value.trim().is_empty())
        .or_else(|| provider_id.and_then(|id| keychain_key(PROVIDER_KEYCHAIN_SERVICE, &id)));
    fetch_provider_models_from_endpoint(&base_url, key.as_deref()).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyCheck {
    id: String,
    #[serde(default)]
    env_names: Vec<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    local: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyStatus {
    provider_id: String,
    configured: bool,
    source: Option<String>,
}

fn provider_is_local(provider_id: &str, base_url: Option<&str>, local: Option<bool>) -> bool {
    if local.unwrap_or(false) {
        return true;
    }
    if provider_id == "lmstudio" {
        return true;
    }
    base_url
        .map(|value| value.contains("127.0.0.1") || value.contains("localhost"))
        .unwrap_or(false)
}

#[tauri::command]
fn provider_key_status(providers: Vec<ProviderKeyCheck>) -> Vec<ProviderKeyStatus> {
    providers
        .into_iter()
        .map(|provider| {
            for env_name in &provider.env_names {
                if std::env::var(env_name)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
                {
                    return ProviderKeyStatus {
                        provider_id: provider.id,
                        configured: true,
                        source: Some("environment".to_string()),
                    };
                }
            }
            if keychain_key(PROVIDER_KEYCHAIN_SERVICE, &provider.id).is_some() {
                return ProviderKeyStatus {
                    provider_id: provider.id,
                    configured: true,
                    source: Some("keychain".to_string()),
                };
            }
            if provider.id == "openai"
                && keychain_key("com.plex.desktop.openai", "default").is_some()
            {
                return ProviderKeyStatus {
                    provider_id: provider.id,
                    configured: true,
                    source: Some("keychain".to_string()),
                };
            }
            if provider_is_local(
                &provider.id,
                provider.base_url.as_deref(),
                provider.local,
            ) {
                return ProviderKeyStatus {
                    provider_id: provider.id,
                    configured: true,
                    source: Some("local".to_string()),
                };
            }
            ProviderKeyStatus {
                provider_id: provider.id,
                configured: false,
                source: None,
            }
        })
        .collect()
}

#[tauri::command]
fn save_provider_key(provider_id: String, key: String) -> Result<(), String> {
    let provider_id = provider_id.trim();
    let key = key.trim();
    if provider_id.is_empty() {
        return Err("供应商 ID 不能为空".to_string());
    }
    if key.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    write_keychain_key(PROVIDER_KEYCHAIN_SERVICE, provider_id, key)
}

#[tauri::command]
fn delete_provider_key(provider_id: String) -> Result<(), String> {
    delete_keychain_key(PROVIDER_KEYCHAIN_SERVICE, provider_id.trim())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigPayload {
    id: String,
    name: String,
    base_url: String,
    #[serde(default)]
    api_style: String,
    model_id: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    env_names: Vec<String>,
    #[serde(default)]
    local: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartTaskPayload {
    prompt: String,
    workspace: String,
    provider: ProviderConfigPayload,
}

fn resolve_provider_key(provider: &ProviderConfigPayload) -> Result<String, String> {
    for env_name in &provider.env_names {
        if let Ok(value) = std::env::var(env_name) {
            if !value.trim().is_empty() {
                return Ok(value);
            }
        }
    }
    if let Some(key) = keychain_key(PROVIDER_KEYCHAIN_SERVICE, &provider.id) {
        return Ok(key);
    }
    if provider.id == "openai" {
        if let Some(key) = keychain_key("com.plex.desktop.openai", "default") {
            return Ok(key);
        }
    }
    if provider_is_local(
        &provider.id,
        Some(&provider.base_url),
        provider.local,
    ) {
        return Ok("local".to_string());
    }
    Err(format!(
        "MISSING_API_KEY:请先在设置中为 {} 配置 API Key",
        provider.name
    ))
}

#[tauri::command]
fn start_task(
    app: AppHandle,
    state: State<'_, SidecarState>,
    payload: StartTaskPayload,
) -> Result<Value, String> {
    if payload.prompt.trim().is_empty() {
        return Err("任务目标不能为空".to_string());
    }
    if payload.workspace.trim().is_empty() {
        return Err("工作目录不能为空".to_string());
    }

    let api_key = resolve_provider_key(&payload.provider)?;
    ensure_sidecar(&app, state.inner())?;
    let request_id = format!("ui-{}", unix_now());
    let request = serde_json::json!({
        "id": request_id,
        "type": "start_task",
        "payload": {
            "prompt": payload.prompt,
            "workspace": payload.workspace,
            "provider": {
                "id": payload.provider.id,
                "name": payload.provider.name,
                "baseUrl": payload.provider.base_url,
                "apiStyle": payload.provider.api_style,
                "modelId": payload.provider.model_id,
                "reasoningEffort": payload.provider.reasoning_effort,
                "apiKey": api_key,
            }
        }
    });
    send_sidecar_request(state.inner(), &request)?;
    Ok(serde_json::json!({ "sent": true }))
}

#[tauri::command]
fn save_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
    key: String,
) -> Result<(), String> {
    save_provider_key("openai".to_string(), key)?;
    start_sidecar(&app, state.inner())
}

#[tauri::command]
fn delete_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<(), String> {
    delete_provider_key("openai".to_string())?;
    start_sidecar(&app, state.inner())
}

#[tauri::command]
fn restart_sidecar(app: AppHandle, state: State<'_, SidecarState>) -> Result<(), String> {
    start_sidecar(&app, state.inner())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_start,
            sidecar_stop,
            sidecar_send,
            sidecar_status,
            models_catalog,
            list_custom_providers,
            save_custom_provider,
            delete_custom_provider,
            fetch_provider_models,
            provider_key_status,
            save_provider_key,
            delete_provider_key,
            start_task,
            save_api_key,
            delete_api_key,
            restart_sidecar
        ])
        .run(tauri::generate_context!())
        .expect("error while running Plex");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn detects_local_providers() {
        assert!(provider_is_local("lmstudio", None, None));
        assert!(provider_is_local(
            "custom",
            Some("http://127.0.0.1:1234/v1"),
            None
        ));
        assert!(!provider_is_local(
            "openrouter",
            Some("https://openrouter.ai/api/v1"),
            None
        ));
    }

    #[test]
    fn resolves_provider_key_from_local_endpoint() {
        let provider = ProviderConfigPayload {
            id: "lmstudio".to_string(),
            name: "LMStudio".to_string(),
            base_url: "http://127.0.0.1:1234/v1".to_string(),
            api_style: "chat_completions".to_string(),
            model_id: "local-model".to_string(),
            reasoning_effort: None,
            env_names: vec![],
            local: Some(true),
        };
        assert_eq!(resolve_provider_key(&provider).unwrap(), "local");
    }

    #[test]
    fn builds_models_endpoint() {
        assert_eq!(
            models_endpoint("https://example.com/v1/"),
            "https://example.com/v1/models"
        );
        assert_eq!(
            models_endpoint("https://example.com/v1/models"),
            "https://example.com/v1/models"
        );
    }

    #[test]
    fn parses_different_model_list_shapes() {
        let openai_shape = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "z-model", "name": "Z Model" },
                { "id": "a-model" }
            ]
        });
        let models = parse_model_list(&openai_shape).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "a-model");
        assert_eq!(models[1].id, "z-model");
        assert_eq!(models[1].name.as_deref(), Some("Z Model"));

        let ollama_shape = serde_json::json!({
            "models": [{ "model": "llama-local" }]
        });
        let models = parse_model_list(&ollama_shape).unwrap();
        assert_eq!(models[0].id, "llama-local");
    }

    #[test]
    fn fetches_models_from_local_compatible_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let _ = sender.send(request);
            let body = r#"{"object":"list","data":[{"id":"model-b"},{"id":"model-a"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let models = tauri::async_runtime::block_on(fetch_provider_models_from_endpoint(
            &format!("http://{address}/v1"),
            Some("test-key"),
        ))
        .unwrap();
        let request = receiver.recv().unwrap().to_lowercase();
        assert!(request.contains("get /v1/models"));
        assert!(request.contains("authorization: bearer test-key"));
        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            vec!["model-a", "model-b"]
        );
    }

    #[test]
    fn normalizes_and_persists_custom_providers() {
        let provider = normalize_custom_provider(CustomProviderConfig {
            id: String::new(),
            name: "  Company Gateway  ".to_string(),
            base_url: "https://gateway.example.com/v1/".to_string(),
            api_style: "chat_completions".to_string(),
            models: vec![CustomProviderModel {
                id: "internal-model".to_string(),
                name: Some("Internal".to_string()),
            }],
        })
        .unwrap();
        assert!(provider.id.starts_with("custom:"));
        assert_eq!(provider.name, "Company Gateway");
        assert_eq!(provider.base_url, "https://gateway.example.com/v1");

        let path = std::env::temp_dir().join(format!(
            "plex-custom-providers-{}.json",
            unix_millis()
        ));
        write_custom_providers_to_path(&path, &[provider.clone()]).unwrap();
        let loaded = read_custom_providers_from_path(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, provider.id);
        assert_eq!(loaded[0].models[0].id, "internal-model");
        let _ = std::fs::remove_file(path);

        let invalid = normalize_custom_provider(CustomProviderConfig {
            id: "custom:x".to_string(),
            name: "Bad".to_string(),
            base_url: "ftp://example.com".to_string(),
            api_style: "chat_completions".to_string(),
            models: vec![],
        });
        assert!(invalid.is_err());
    }

    #[test]
    #[ignore = "requires network access to models.dev"]
    fn models_dev_is_reachable() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .user_agent("Plex/0.1.0-test")
            .build()
            .unwrap();
        let text = tauri::async_runtime::block_on(async {
            client
                .get(MODELS_DEV_URL)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        assert!(text.contains("\"openai\""));
        assert!(text.len() > 1_000_000);
    }
}
