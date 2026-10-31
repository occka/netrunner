import { Component, type ReactNode } from "react";
import { AlertOctagon } from "lucide-react";

interface State {
  error: Error | null;
}

/** Keeps a crashing module or widget from taking down the whole shell. */
export class ErrorBoundary extends Component<{ children: ReactNode; compact?: boolean }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("NETRUNNER component error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.compact ? "unavailable" : "crash"}>
        <AlertOctagon size={16} color="var(--c-critical)" />
        <div>
          <div className="label">Component failure</div>
          <div className="mono" data-selectable>
            {this.state.error.message}
          </div>
          <button className="btn btn--sm" style={{ marginTop: 8 }} onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      </div>
    );
  }
}
