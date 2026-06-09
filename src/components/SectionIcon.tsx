export const sectionIconOptions = [
  { id: "folder", label: "Розділ" },
  { id: "village", label: "Населений пункт" },
  { id: "building", label: "Будівля" },
  { id: "landmark", label: "Установа" },
  { id: "calendar", label: "Хронологія" },
  { id: "archive", label: "Архів" },
  { id: "book", label: "Книга" },
  { id: "map", label: "Карта" },
  { id: "people", label: "Люди" },
  { id: "camera", label: "Світлини" },
  { id: "microphone", label: "Усні свідчення" },
  { id: "star", label: "Важливе" },
] as const;

export function SectionIcon({
  icon,
  size = 20,
}: {
  icon: string;
  size?: number;
}) {
  const paths: Record<string, React.ReactNode> = {
    folder: <><path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 9h18" /></>,
    village: <><path d="M3 21V10l6-5 6 5v11" /><path d="M15 13l3-3 3 3v8" /><path d="M7 21v-6h4v6" /></>,
    building: <><path d="M4 21V5l8-3 8 3v16" /><path d="M8 8h1M8 12h1M8 16h1M15 8h1M15 12h1M15 16h1" /><path d="M2 21h20" /></>,
    landmark: <><path d="M3 9h18" /><path d="M5 9V7l7-4 7 4v2" /><path d="M6 9v9M10 9v9M14 9v9M18 9v9" /><path d="M3 18h18v3H3z" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M8 14h2M14 14h2M8 18h2M14 18h2" /></>,
    archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v11h14V9M9 13h6" /></>,
    book: <><path d="M4 4.5A3.5 3.5 0 0 1 7.5 1H12v19H7.5A3.5 3.5 0 0 0 4 23z" /><path d="M20 4.5A3.5 3.5 0 0 0 16.5 1H12v19h4.5A3.5 3.5 0 0 1 20 23z" /></>,
    map: <><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15M15 6v15" /></>,
    people: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M15 15a5 5 0 0 1 6 4.8V21" /></>,
    camera: <><path d="M4 7h4l2-3h4l2 3h4a2 2 0 0 1 2 2v10H2V9a2 2 0 0 1 2-2z" /><circle cx="12" cy="13" r="4" /></>,
    microphone: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" /></>,
    star: <path d="M12 2l3 6 6.5 1-4.7 4.6 1.1 6.4-5.9-3.1L6.1 20l1.1-6.4L2.5 9 9 8z" />,
  };
  const graphic = paths[icon];
  if (!graphic) return <span aria-hidden="true">{icon || "Р"}</span>;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {graphic}
    </svg>
  );
}
