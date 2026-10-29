import { el, setIconImpl, type ElementNode } from "./nodes";

export const DEFAULT_ICON = "sparkles";
type Shape = [string, Record<string, string>];

export const ICONS: Record<string, Shape[]> = {
  zap: [["polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" }]],
  shield: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }]],
  chart: [["line", { x1: "12", y1: "20", x2: "12", y2: "10" }], ["line", { x1: "18", y1: "20", x2: "18", y2: "4" }], ["line", { x1: "6", y1: "20", x2: "6", y2: "16" }]],
  globe: [["circle", { cx: "12", cy: "12", r: "10" }], ["line", { x1: "2", y1: "12", x2: "22", y2: "12" }], ["path", { d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" }]],
  layers: [["polygon", { points: "12 2 2 7 12 12 22 7 12 2" }], ["polyline", { points: "2 17 12 22 22 17" }], ["polyline", { points: "2 12 12 17 22 12" }]],
  star: [["polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }]],
  users: [["path", { d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" }], ["circle", { cx: "9", cy: "7", r: "4" }], ["path", { d: "M23 21v-2a4 4 0 0 0-3-3.87" }], ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }]],
  code: [["polyline", { points: "16 18 22 12 16 6" }], ["polyline", { points: "8 6 2 12 8 18" }]],
  clock: [["circle", { cx: "12", cy: "12", r: "10" }], ["polyline", { points: "12 6 12 12 16 14" }]],
  heart: [["path", { d: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" }]],
  lock: [["rect", { x: "3", y: "11", width: "18", height: "11", rx: "2", ry: "2" }], ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }]],
  sparkles: [["path", { d: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" }], ["path", { d: "M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z" }]],
  layout: [["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", ry: "2" }], ["line", { x1: "3", y1: "9", x2: "21", y2: "9" }], ["line", { x1: "9", y1: "21", x2: "9", y2: "9" }]],
  check: [["polyline", { points: "20 6 9 17 4 12" }]],
};
export const ICON_NAMES = Object.keys(ICONS);

const SVG_ATTRS = {
  viewBox: "0 0 24 24", width: "24", height: "24", fill: "none", stroke: "currentColor", "stroke-width": "2",
  "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
};

export function iconElement(name: string, size = 24): ElementNode {
  const shapes = ICONS[name] ?? ICONS[DEFAULT_ICON];
  return el("svg", { ...SVG_ATTRS, width: String(size), height: String(size) }, ...shapes.map(([tag, a]) => el(tag, { ...a })));
}
setIconImpl(iconElement);

/** Source of a reusable React <Icon /> component carrying the same set. */
export function iconComponentJsx(): string {
  const table = JSON.stringify(Object.fromEntries(Object.entries(ICONS)), null, 2);
  return `const ICONS = ${table};

export default function Icon({ name, size = 24 }) {
  const shapes = ICONS[name] || ICONS.${DEFAULT_ICON};
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes.map(([Tag, attrs], i) => (
        <Tag key={i} {...attrs} />
      ))}
    </svg>
  );
}
`;
}
