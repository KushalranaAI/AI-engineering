import { Component, type ReactNode } from "react";

/** Keeps one broken screen from blanking the whole app. Resets when the route changes (via `key`). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page narrow">
        <div className="empty-state">
          <h1>This page hit an error.</h1>
          <p className="muted">Your progress is safe. Try another page, or reload.</p>
          <pre className="small muted">{this.state.error.message}</pre>
          <a className="btn" href="#/">Go home</a>
        </div>
      </div>
    );
  }
}
