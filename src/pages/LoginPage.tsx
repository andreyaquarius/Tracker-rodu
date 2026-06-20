import { useEffect, useState, type FormEvent } from "react";

type LoginMode = "signIn" | "signUp" | "forgotPassword" | "resetPassword";

interface LoginPageProps {
  onGoogle: () => void;
  onEmailSignIn: (email: string, password: string) => Promise<void>;
  onEmailSignUp: (
    name: string,
    email: string,
    password: string,
  ) => Promise<{ confirmationRequired: boolean }>;
  onPasswordResetRequest: (email: string) => Promise<void>;
  onPasswordUpdate: (password: string) => Promise<void>;
  passwordRecovery: boolean;
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
    return "Надсилання листів на цю адресу поки недоступне. Потрібно налаштувати поштову відправку.";
  }
  if (message.toLocaleLowerCase().includes("rate limit")) {
    return "Перевищено обмеження на надсилання листів. Спробуйте пізніше або перевірте SMTP-налаштування.";
  }
  if (message.toLocaleLowerCase().includes("same password")) {
    return "Новий пароль має відрізнятися від попереднього.";
  }
  return message || "Не вдалося виконати авторизацію.";
}

export function LoginPage({
  onGoogle,
  onEmailSignIn,
  onEmailSignUp,
  onPasswordResetRequest,
  onPasswordUpdate,
  passwordRecovery,
  loading,
  error,
}: LoginPageProps) {
  const [mode, setMode] = useState<LoginMode>(
    passwordRecovery ? "resetPassword" : "signIn",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (passwordRecovery) {
      setMode("resetPassword");
      setFormError("");
      setNotice("");
    }
  }, [passwordRecovery]);

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
      } else if (mode === "forgotPassword") {
        await onPasswordResetRequest(email);
        setNotice(
          "Посилання для відновлення пароля надіслано. Перевірте вхідні листи та папку «Спам».",
        );
      } else if (mode === "resetPassword") {
        if (password !== passwordConfirmation) {
          throw new Error("Паролі не збігаються.");
        }
        await onPasswordUpdate(password);
      } else {
        await onEmailSignIn(email, password);
      }
    } catch (authError) {
      setFormError(describeAuthError(authError));
    } finally {
      setFormBusy(false);
    }
  };

  const switchMode = (nextMode: LoginMode) => {
    setMode(nextMode);
    setFormError("");
    setNotice("");
    setPassword("");
    setPasswordConfirmation("");
  };

  const heading =
    mode === "signUp"
      ? "Створіть обліковий запис"
      : mode === "forgotPassword"
        ? "Відновлення пароля"
        : mode === "resetPassword"
          ? "Створіть новий пароль"
          : "Увійдіть до Трекера Роду";

  const description =
    mode === "signUp"
      ? "Зареєструйтеся та отримайте 30 днів тестового доступу."
      : mode === "forgotPassword"
        ? "Введіть електронну адресу, і ми надішлемо посилання для зміни пароля."
        : mode === "resetPassword"
          ? "Введіть новий пароль для вашого облікового запису."
          : "Увійдіть через Google або за допомогою електронної пошти.";

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
        <h2>{heading}</h2>
        <p>{description}</p>
        {error || formError ? (
          <div className="alert alert-error">{formError || error}</div>
        ) : null}
        {notice ? <div className="alert alert-notice">{notice}</div> : null}
        {mode === "signIn" || mode === "signUp" ? (
          <>
            <button className="button button-google" onClick={onGoogle} disabled={loading}>
              <span>G</span>{loading ? "Підключення…" : "Увійти через Google"}
            </button>
            <div className="login-divider"><span>або</span></div>
          </>
        ) : null}
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
          {mode !== "resetPassword" ? (
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
          ) : null}
          {mode !== "forgotPassword" ? (
            <label>
              <span>{mode === "resetPassword" ? "Новий пароль" : "Пароль"}</span>
              <input
                type="password"
                required
                minLength={6}
                autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "resetPassword" ? (
            <label>
              <span>Повторіть новий пароль</span>
              <input
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "signIn" ? (
            <button
              type="button"
              className="login-forgot-button"
              onClick={() => switchMode("forgotPassword")}
            >
              Забули пароль?
            </button>
          ) : null}
          <button
            type="submit"
            className="button button-primary"
            disabled={formBusy || loading}
          >
            {formBusy
              ? "Зачекайте…"
              : mode === "signUp"
                ? "Зареєструватися"
                : mode === "forgotPassword"
                  ? "Надіслати посилання"
                  : mode === "resetPassword"
                    ? "Зберегти новий пароль"
                    : "Увійти"}
          </button>
        </form>
        {mode !== "resetPassword" ? (
          <button
            type="button"
            className="login-mode-button"
            onClick={() => switchMode(mode === "signIn" ? "signUp" : "signIn")}
          >
            {mode === "signIn"
              ? "Ще не маєте облікового запису? Зареєструватися"
              : mode === "signUp"
                ? "Уже маєте обліковий запис? Увійти"
                : "Повернутися до входу"}
          </button>
        ) : null}
      </section>
    </main>
  );
}
