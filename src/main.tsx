import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from "react";
import ReactDOM from "react-dom/client";
import { resolveTheme } from "./theme";
import "./App.css";

const App = lazy(() => import("./App"));

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Plex 前端启动失败", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-boot app-boot-error" role="alert">
          <div>
            <strong>Plex 未能启动</strong>
            <p>{this.state.error.message || "前端初始化时发生未知错误。"}</p>
            <button type="button" onClick={() => window.location.reload()}>
              重新加载
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

function AppBoot() {
  return (
    <main className="app-boot" role="status" aria-live="polite">
      <div className="app-boot-brand">
        <span className="brand-dot" />
        <strong>Plex</strong>
      </div>
      <div className="app-boot-status">
        <span className="loading-spinner" />
        <span>正在打开工作区…</span>
      </div>
    </main>
  );
}

document.documentElement.dataset.theme = resolveTheme(
  localStorage.getItem("plex.theme"),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppErrorBoundary>
    <Suspense fallback={<AppBoot />}>
      <App />
    </Suspense>
  </AppErrorBoundary>,
);
