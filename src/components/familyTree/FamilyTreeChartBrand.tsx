import {
  TRACKER_RODU_CHART_BRAND_NAME,
  TRACKER_RODU_CHART_LOGO_URL,
  type FamilyTreeChartBrandPlacement,
} from "../../features/family-tree-view/export/familyTreeChartBrand.ts";

interface FamilyTreeChartBrandProps {
  placement: FamilyTreeChartBrandPlacement;
}

/** Native SVG only: this remains reliable in standalone SVG, PNG and PDF exports. */
export function FamilyTreeChartBrand({ placement }: FamilyTreeChartBrandProps) {
  return (
    <svg
      className="family-tree-chart-brand"
      data-family-tree-chart-brand="true"
      x={placement.x}
      y={placement.y}
      width={placement.width}
      height={placement.height}
      viewBox="0 0 240 56"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      style={{ pointerEvents: "none" }}
    >
      <title>Створено у Трекері Роду</title>
      <rect
        x="0.75"
        y="0.75"
        width="238.5"
        height="54.5"
        rx="13"
        fill="#fffdfa"
        fillOpacity="0.95"
        stroke="#afc5bd"
        strokeWidth="1.5"
      />
      <image
        data-family-tree-chart-brand-logo="true"
        href={TRACKER_RODU_CHART_LOGO_URL}
        xlinkHref={TRACKER_RODU_CHART_LOGO_URL}
        x="7"
        y="5"
        width="46"
        height="46"
        preserveAspectRatio="xMidYMid meet"
      />
      <text
        x="64"
        y="35.5"
        fill="#174c40"
        fontFamily={'Georgia, "Times New Roman", serif'}
        fontSize="20"
        fontWeight="700"
        letterSpacing="-.2"
      >
        {TRACKER_RODU_CHART_BRAND_NAME}
      </text>
    </svg>
  );
}
