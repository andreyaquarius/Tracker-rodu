import { Component, type ErrorInfo, type ReactNode } from "react";
import { FamilyTreeErrorState } from "./FamilyTreeStates";

interface FamilyTreeErrorBoundaryProps {
  children: ReactNode;
}

interface FamilyTreeErrorBoundaryState {
  message: string;
}

export class FamilyTreeErrorBoundary extends Component<
  FamilyTreeErrorBoundaryProps,
  FamilyTreeErrorBoundaryState
> {
  state: FamilyTreeErrorBoundaryState = { message: "" };

  static getDerivedStateFromError(error: unknown): FamilyTreeErrorBoundaryState {
    return {
      message: error instanceof Error && error.message
        ? error.message
        : "Не вдалося відкрити сторінку родового дерева.",
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("Family tree viewer crashed", error, info);
    }
  }

  render() {
    if (this.state.message) {
      return (
        <FamilyTreeErrorState
          message={this.state.message}
          onRetry={() => this.setState({ message: "" })}
        />
      );
    }

    return this.props.children;
  }
}
