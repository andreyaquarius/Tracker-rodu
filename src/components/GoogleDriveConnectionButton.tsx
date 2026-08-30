import { useEffect, useState } from "react";
import {
  authorizeGoogleDrive,
  getGoogleDriveConnectionState,
  prepareGoogleDriveAuthorization,
  subscribeGoogleDriveConnectionState,
} from "../services/googleDriveStorage";

export function GoogleDriveConnectionButton() {
  const [ready, setReady] = useState(false);
  const [connectionState, setConnectionState] = useState(() => getGoogleDriveConnectionState());
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeGoogleDriveConnectionState((state) => {
      if (cancelled) return;
      setConnectionState(state);
      if (state.authorized) {
        setReady(true);
        setError("");
      }
    });

    prepareGoogleDriveAuthorization()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setReady(false);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Не вдалося підготувати підключення Google Drive.",
        );
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    setError("");
    try {
      await authorizeGoogleDrive();
    } catch (connectError) {
      const actualState = getGoogleDriveConnectionState();
      setConnectionState(actualState);
      if (!actualState.authorized) {
        setError(connectError instanceof Error ? connectError.message : "Не вдалося підключити Google Drive.");
      }
    } finally {
      setConnectionState(getGoogleDriveConnectionState());
      setConnecting(false);
    }
  };

  const label = connectionState.authorized
    ? "Google Drive підключено"
    : connectionState.knownConnection
      ? "Відновити Google Drive"
      : "Підключити Google Drive";

  return (
    <div className="drive-connection-action">
      <button
        type="button"
        className={`drive-connection-button ${connectionState.authorized ? "connected" : ""}`}
        disabled={!ready || connecting}
        onClick={() => void connect()}
        title={error || label}
      >
        <span className="drive-connection-dot" />
        <span>{connecting ? "Підключення…" : label}</span>
      </button>
      {error ? <small>{error}</small> : null}
    </div>
  );
}
