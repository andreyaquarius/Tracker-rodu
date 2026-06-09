import { useState, type FormEvent } from "react";

interface LoginPageProps {
  onGoogle: () => void;
  onEmailSignIn: (email: string, password: string) => Promise<void>;
  onEmailSignUp: (
    name: string,
    email: string,
    password: string,
  ) => Promise<{ confirmationRequired: boolean }>;
  loading: boolean;
  error?: string;
}

function describeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Invalid login credentials")) {
    return "Неправильна електронна адреса або пароль.";
  }
  if (message.includes("Email not confirmed")) {
    return "Підтвердьте електронну адресу за посиланням у листі.";
  }
  if (message.includes("User already registered")) {
    return "Обліковий запис із цією адресою вже існує.";
  }
  if (message.includes("Password should be")) {
    return "Пароль має містити щонайменше 6 символів.";
  }
  if (message.includes("Email address not authorized")) {
    return "Supabase поки не дозволяє надсилати листи на цю адресу. Потрібно налаштувати власну SMTP-пошту.";
  }
  if (message.toLocaleLowerCase().includes("rate limit")) {
    return "Перевищено обмеження на надсилання листів. Спробуйте пізніше або перевірте SMTP-налаштування.";
  }
  return message || "Не вдалося виконати авторизацію.";
}

export function LoginPage({
  onGoogle,
  onEmailSignIn,
  onEmailSignUp,
  loading,
  error,
}: LoginPageProps) {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormBusy(true);
    setFormError("");
    setNotice("");
    try {
      if (mode === "signUp") {
        const result = await onEmailSignUp(name, email, password);
        if (result.confirmationRequired) {
          setNotice(
            "Реєстрацію завершено. Перевірте пошту та підтвердьте електронну адресу.",
          );
        }
      } else {
        await onEmailSignIn(email, password);
      }
    } catch (authError) {
      setFormError(describeAuthError(authError));
    } finally {
      setFormBusy(false);
    }
  };

  const switchMode = (nextMode: "signIn" | "signUp") => {
    setMode(nextMode);
    setFormError("");
    setNotice("");
  };

  return (
    <main className="login-page">
      <section className="login-copy">
        <div className="brand login-brand">
          <div className="brand-mark">
            <img src="/tracker-rodu-logo.png" alt="" />
          </div>
          <strong>Трекер Роду</strong>
        </div>
        <span className="eyebrow">Робочий простір для генеалогічного дослідження</span>
        <h1>Не губи сліди свого роду</h1>
        <p>Керуйте родовим дослідженням: від першої зачіпки до підтвердженого факту</p>
      </section>
      <section className="login-card">
        <span className="eyebrow">Початок роботи</span>
        <h2>{mode === "signIn" ? "Увійдіть до Трекера Роду" : "Створіть обліковий запис"}</h2>
        <p>
          {mode === "signIn"
            ? "Увійдіть через Google або за допомогою електронної пошти."
            : "Зареєструйтеся за допомогою електронної пошти."}
        </p>
        {error || formError ? (
          <div className="alert alert-error">{formError || error}</div>
        ) : null}
        {notice ? <div className="alert alert-notice">{notice}</div> : null}
        <button className="button button-google" onClick={onGoogle} disabled={loading}>
          <span>G</span>{loading ? "Підключення…" : "Увійти через Google"}
        </button>
        <div className="login-divider"><span>або</span></div>
        <form className="login-email-form" onSubmit={submit}>
          {mode === "signUp" ? (
            <label>
              <span>Ім’я</span>
              <input
                required
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            <span>Електронна пошта</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>Пароль</span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button button-primary"
            disabled={formBusy || loading}
          >
            {formBusy
              ? "Зачекайте…"
              : mode === "signIn"
                ? "Увійти"
                : "Зареєструватися"}
          </button>
        </form>
        <button
          type="button"
          className="login-mode-button"
          onClick={() => switchMode(mode === "signIn" ? "signUp" : "signIn")}
        >
          {mode === "signIn"
            ? "Ще не маєте облікового запису? Зареєструватися"
            : "Уже маєте обліковий запис? Увійти"}
        </button>
      </section>
    </main>
  );
}
