interface LoginPageProps {
  onGoogle: () => void;
  onLocal: () => void;
  loading: boolean;
  error?: string;
}

export function LoginPage({ onGoogle, onLocal, loading, error }: LoginPageProps) {
  return (
    <main className="login-page">
      <section className="login-copy">
        <div className="brand login-brand"><div className="brand-mark">ТР</div><strong>Трекер Роду</strong></div>
        <span className="eyebrow">Робочий простір для генеалогічного дослідження</span>
        <h1>Не губи сліди свого роду</h1>
        <p>Ведіть документи, завдання, знахідки, гіпотези та прогалини по роках в одному місці.</p>
        <div className="login-points">
          <span>✓ Автозбереження після кожної зміни</span>
          <span>✓ Приватна папка даних застосунку</span>
          <span>✓ Робота офлайн без власного сервера</span>
        </div>
      </section>
      <section className="login-card">
        <span className="eyebrow">Початок роботи</span>
        <h2>Почніть роботу в Трекері Роду</h2>
        <p>Увійдіть через Google, щоб синхронізувати дослідження з вашим Google Drive, або почніть локально.</p>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <button className="button button-google" onClick={onGoogle} disabled={loading}>
          <span>G</span>{loading ? "Підключення…" : "Увійти через Google"}
        </button>
        <button className="button button-secondary" onClick={onLocal}>Продовжити локально</button>
        <small>Трекер Роду просить лише профіль та доступ до прихованої папки власних даних.</small>
      </section>
    </main>
  );
}
