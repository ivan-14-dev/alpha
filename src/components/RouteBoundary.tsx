import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './ui';

export default class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Impossible de charger cet espace Alpha.', error, info.componentStack);
  }

  render() {
    if (this.state.failed) return <section className="stack">
      <ErrorState message="Cet espace n’a pas pu être chargé. Vérifiez votre connexion puis rechargez la page." />
      <div><button type="button" className="button button-primary" onClick={() => window.location.reload()}>Recharger la page</button></div>
    </section>;
    return this.props.children;
  }
}
