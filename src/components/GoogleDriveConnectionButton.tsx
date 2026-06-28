import { useEffect, useState } from "react";
import {
  authorizeGoogleDrive,
  hasGoogleDriveConnectionHint,
  isGoogleDriveAuthorized,
  prepareGoogleDriveAuthorization,
} from "../services/googleDriveStorage";

export function GoogleDriveConnectionButton() {
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(isGoogleDriveAuthorized());
  const [knownConnection, setKnownConnection] = useState(hasGoogleDriveConnectionHint());
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    prepareGoogleDriveAuthorization()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(false);
      });

    const refreshState = () => {
      setConnected(isGoogleDriveAuthorized());
      setKnownConnection(hasGoogleDriveConnectionHint());
    };
    const intervalId = window.setInterval(refreshState, 30_000);
    window.addEventListener("focus", refreshState);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshState);
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    setError("");
    try {
      await authorizeGoogleDrive();
      setConnected(true);
      setKnownConnection(true);
    } catch (connectError) {
      setConnected(false);
      setError(connectError instanceof Error ? connectError.message : "Не вдалося підключити Google Drive.");
    } finally {
      setConnecting(false);
    }
  };

  const label = connected
    ? "Google Drive підключено"
    : knownConnection
      ? "Оновити Google Drive"
      : "Підключити Google Drive";

  return (
    <div className="drive-connection-action">
      <button
        type="button"
        className={`drive-connection-button ${connected ? "connected" : ""}`}
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
