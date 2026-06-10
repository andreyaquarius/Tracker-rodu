import type { CustomSectionDefinition, SectionParentKey } from "../types";
import type { CustomFieldModule } from "../types";
import type { PageKey } from "./Sidebar";
import { SectionIcon } from "./SectionIcon";
import {
  childSections,
  customSectionKey,
  hierarchyRootLabels,
  sectionAncestors,
} from "../utils/sectionHierarchy";

export function SectionHierarchyHeader({
  page,
  sections,
  canManage,
  onNavigate,
  onCreateChild,
}: {
  page: SectionParentKey;
  sections: CustomSectionDefinition[];
  canManage: boolean;
  onNavigate: (page: PageKey) => void;
  onCreateChild: (parentKey: SectionParentKey) => void;
}) {
  const currentSection = page.startsWith("custom:")
    ? sections.find((section) => customSectionKey(section.id) === page)
    : undefined;
  const breadcrumbs = currentSection
    ? [
        ...sectionAncestors(sections, currentSection),
        { key: page, label: currentSection.name },
      ]
    : [{
        key: page,
        label: hierarchyRootLabels[page as CustomFieldModule],
      }];
  const children = childSections(sections, page);

  return (
    <div className="section-hierarchy">
      <nav className="breadcrumbs" aria-label="Шлях до розділу">
        {breadcrumbs.map((item, index) => (
          <span key={item.key}>
            {index ? <span className="breadcrumb-separator">›</span> : null}
            <button
              type="button"
              disabled={item.key === page}
              onClick={() => onNavigate(item.key as PageKey)}
            >
              {item.label}
            </button>
          </span>
        ))}
      </nav>

      {children.length || canManage ? (
        <section className="subsection-panel">
          <div className="subsection-heading">
            <div>
              <strong>Підрозділи</strong>
              <small>
                {children.length
                  ? `${children.length} вкладених розділів`
                  : "У цього розділу ще немає підрозділів"}
              </small>
            </div>
            {canManage ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => onCreateChild(page)}
              >
                + Створити підрозділ
              </button>
            ) : null}
          </div>
          {children.length ? (
            <div className="subsection-grid">
              {children.map((section) => (
                <button
                  type="button"
                  key={section.id}
                  onClick={() => onNavigate(customSectionKey(section.id))}
                >
                  <span className="custom-section-icon">
                    <SectionIcon icon={section.icon} size={22} />
                  </span>
                  <span>
                    <strong>{section.name}</strong>
                    <small>
                      {section.description || `${section.fields.length} полів`}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
