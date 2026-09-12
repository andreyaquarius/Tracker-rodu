import "./communityResources.css";

export function CommunityResources({ variant = "workspace" }: { variant?: "home" | "workspace" }) {
  return (
    <aside className={`community-resources community-resources--${variant}`} aria-label="Канали та відео про дослідження роду">
      <nav className="community-social-links" aria-label="Наші канали">
        <a
          href="https://t.me/myrodovid"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Telegram (у новій вкладці)"
        >
          Telegram <span aria-hidden="true">↗</span>
        </a>
        <a
          href="https://www.youtube.com/@Myrodovid"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="YouTube (у новій вкладці)"
        >
          YouTube <span aria-hidden="true">↗</span>
        </a>
      </nav>
      <a
        className="community-video-resource"
        href="https://suziria.trekerrodu.com.ua/"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Сузір’я Роду — відео про дослідження роду та краєзнавство (у новій вкладці)"
      >
        <span className="community-video-resource-copy">
          <strong>Сузір’я Роду</strong>
          <span>Відео про дослідження роду та краєзнавство.</span>
        </span>
        <span className="community-resource-arrow" aria-hidden="true">↗</span>
      </a>
    </aside>
  );
}
