use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYCHAIN_SERVICE: &str = "com.plex.desktop.openai";
const KEYCHAIN_ACCOUNT: &str = "default";

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
fn read_keychain_api_key() -> Option<String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
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
fn read_keychain_api_key() -> Option<String> {
    None
}

fn configured_api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(read_keychain_api_key)
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

#[cfg(target_os = "macos")]
fn write_keychain_api_key(key: &str) -> Result<(), String> {
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
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
fn write_keychain_api_key(_key: &str) -> Result<(), String> {
    Err("当前平台尚未实现钥匙串写入，请使用 OPENAI_API_KEY 环境变量".to_string())
}

#[cfg(target_os = "macos")]
fn delete_keychain_api_key() -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
        ])
        .output()
        .map_err(|error| format!("无法调用 macOS 钥匙串：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found") || stderr.contains("The specified item could not be found")
    {
        Ok(())
    } else {
        Err(format!("删除 macOS 钥匙串条目失败：{stderr}"))
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_keychain_api_key() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn save_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
    key: String,
) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    write_keychain_api_key(trimmed)?;
    start_sidecar(&app, state.inner())
}

#[tauri::command]
fn delete_api_key(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<(), String> {
    delete_keychain_api_key()?;
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
            save_api_key,
            delete_api_key,
            restart_sidecar
        ])
        .run(tauri::generate_context!())
        .expect("error while running Plex");
}
