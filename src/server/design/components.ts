/**
 * The component registry: Navbar, Hero, Feature grid, Cards, Testimonials, Pricing, FAQ, CTA, Footer.
 * Each component is defined once and carries its strict content schema, its markup as a render tree
 * (serialised to escaped HTML *and* to JSX), and its CSS (written against design tokens). Adding a
 * component means adding one entry here plus its name to layouts.SECTION_TYPES.
 */
import cssData from "./componentCss.json";
import { Bool, Enum, Field, Int, ListOf, Obj, Str } from "./fields";
import { DEFAULT_ICON, ICON_NAMES } from "./icons";
import { HERO_LAYOUTS, HERO_SIZES, SECTION_TYPES } from "./layouts";
import { el, type Ctx, type ElementNode } from "./nodes";

export interface Component {
  type: string;
  label: string;
  description: string;
  fields: Record<string, Field>;
  build: (c: Ctx) => ElementNode;
  css: string;
  cssTablet: string;
  cssMobile: string;
  example: Record<string, unknown>;
  schema(): Obj;
  describe(): string;
}

type CssEntry = { description: string; css: string; css_tablet: string; css_mobile: string; example: Record<string, unknown>; label: string };
const CSS = cssData.components as unknown as Record<string, CssEntry>;

function define(type: string, fields: Record<string, Field>, build: (c: Ctx) => ElementNode): Component {
  const d = CSS[type];
  return {
    type, label: d.label, description: d.description, fields, build,
    css: d.css, cssTablet: d.css_tablet, cssMobile: d.css_mobile, example: d.example,
    schema() { return new Obj({ id: new Str(40, { optional: true }), type: new Enum([type]), ...fields }); },
    describe() { return `${type} (${d.label}) - ${d.description}\n    {${Object.entries(fields).map(([k, f]) => `${k}: ${f.describe()}`).join(", ")}}`; },
  };
}

const section = (tagClass: string, c: Ctx, children: unknown[], extraClass = "") =>
  el("section", { class: `mf-section ${tagClass} ${extraClass}`.trim(), id: c.text("id") }, el("div", { class: "mf-container" }, ...(children as never[])));

const head = (c: Ctx) => el("div", { class: "mf-head" }, el("h2", null, c.text("title")), c.when("subtitle", () => el("p", null, c.text("subtitle"))));

const NAVBAR = define("navbar", {
  brand: new Str(40),
  links: new ListOf(new Obj({ label: new Str(24), target: new Str(32, { optional: true }) }, { acceptStrAs: "label" }), { maxItems: 6, default: [] }),
  cta: new Str(24, { optional: true }),
  cta_target: new Str(32, { optional: true }),
}, (c) =>
  el("header", { class: "mf-nav", id: c.text("id") },
    el("div", { class: "mf-container mf-nav__inner" },
      el("a", { class: "mf-nav__brand", href: "#" }, c.text("brand")),
      el("input", { class: "mf-nav__toggle", type: "checkbox", id: "mf-nav-toggle", "aria-label": "Toggle navigation menu" }),
      el("label", { class: "mf-nav__burger", for: "mf-nav-toggle", "aria-hidden": "true" }, el("span", null)),
      el("nav", { class: "mf-nav__links", "aria-label": "Main" },
        c.each("links", (link) => el("a", { href: link.anchor("target") }, link.text("label"))),
        c.when("cta", () => el("a", { class: "mf-btn mf-btn--primary", href: c.anchor("cta_target") }, c.text("cta"))),
      ))));

const HERO = define("hero", {
  title: new Str(120),
  subtitle: new Str(300, { optional: true }),
  badge: new Str(40, { optional: true }),
  cta: new Str(30, { optional: true }),
  cta_target: new Str(32, { optional: true }),
  secondary_cta: new Str(30, { optional: true }),
  layout: new Enum(HERO_LAYOUTS, { default: "centered" }),
  size: new Enum(Object.keys(HERO_SIZES), { default: "lg" }),
}, (c) => {
  const chart = el("div", { class: "mf-vis__chart" }, ...Array.from({ length: 7 }, () => el("span", null)));
  const visual = el("div", { class: "mf-hero__visual", "aria-hidden": "true" },
    el("div", { class: "mf-vis" },
      el("div", { class: "mf-vis__dots" }, el("i", null), el("i", null), el("i", null)),
      el("div", { class: "mf-vis__row" }, el("span", { class: "mf-vis__pill" }), el("span", { class: "mf-vis__line" })),
      chart,
      el("div", { class: "mf-vis__row" }, el("span", { class: "mf-vis__line mf-vis__line--short" }))));
  return el("section", { class: c.cls("mf-hero", { values: { size: "mf-hero--", layout: "mf-hero--" } }), id: c.text("id") },
    el("div", { class: "mf-container mf-hero__inner" },
      el("div", { class: "mf-hero__copy" },
        c.when("badge", () => el("span", { class: "mf-badge" }, c.text("badge"))),
        el("h1", { class: "mf-hero__title" }, c.text("title")),
        c.when("subtitle", () => el("p", { class: "mf-hero__subtitle" }, c.text("subtitle"))),
        el("div", { class: "mf-hero__actions" },
          c.when("cta", () => el("a", { class: "mf-btn mf-btn--primary", href: c.anchor("cta_target") }, c.text("cta"))),
          c.when("secondary_cta", () => el("a", { class: "mf-btn mf-btn--ghost", href: "#" }, c.text("secondary_cta"))))),
      visual));
});

const FEATURES = define("features", {
  title: new Str(100),
  subtitle: new Str(240, { optional: true }),
  columns: new Int(2, 4, { default: 3 }),
  items: new ListOf(new Obj({
    title: new Str(60), body: new Str(240),
    icon: new Enum(ICON_NAMES, { default: DEFAULT_ICON, fallback: DEFAULT_ICON }),
  }), { minItems: 1, maxItems: 8 }),
}, (c) => section("mf-features", c, [
  head(c),
  el("div", { class: c.cls("mf-grid", { values: { columns: "mf-cols-" } }) },
    c.each("items", (item) => el("article", { class: "mf-feature" },
      el("span", { class: "mf-icon" }, item.icon("icon")),
      el("h3", null, item.text("title")),
      el("p", null, item.text("body"))))),
]));

const CARDS = define("cards", {
  title: new Str(100),
  subtitle: new Str(240, { optional: true }),
  columns: new Int(2, 4, { default: 3 }),
  items: new ListOf(new Obj({
    title: new Str(60), body: new Str(200, { optional: true }), meta: new Str(40, { optional: true }), stat: new Str(20, { optional: true }),
  }), { minItems: 1, maxItems: 9 }),
}, (c) => section("mf-cards", c, [
  head(c),
  el("div", { class: c.cls("mf-grid", { values: { columns: "mf-cols-" } }) },
    c.each("items", (item) => el("article", { class: item.cls("mf-card", { flags: { stat: "mf-card--stat" } }) },
      el("div", { class: "mf-card__thumb", "aria-hidden": "true" }),
      item.when("meta", () => el("span", { class: "mf-card__meta" }, item.text("meta"))),
      item.when("stat", () => el("div", { class: "mf-card__stat" }, item.text("stat"))),
      el("h3", null, item.text("title")),
      item.when("body", () => el("p", null, item.text("body")))))),
]));

const TESTIMONIALS = define("testimonials", {
  title: new Str(100),
  items: new ListOf(new Obj({ quote: new Str(300), name: new Str(50), role: new Str(60, { optional: true }) }), { minItems: 1, maxItems: 6 }),
}, (c) => section("mf-testimonials", c, [
  head(c),
  el("div", { class: c.cls("mf-grid", { counts: { items: ["mf-cols-", 3] } }) },
    c.each("items", (item) => el("figure", { class: "mf-quote" },
      el("blockquote", null, item.text("quote")),
      el("figcaption", null,
        el("span", { class: "mf-avatar", "aria-hidden": "true" }, item.initial("name")),
        el("span", { class: "mf-quote__who" }, el("strong", null, item.text("name")), item.when("role", () => el("span", null, item.text("role")))))))),
], "mf-band"));

const PRICING = define("pricing", {
  title: new Str(100),
  subtitle: new Str(240, { optional: true }),
  tiers: new ListOf(new Obj({
    name: new Str(30), price: new Str(20), period: new Str(20, { optional: true }), description: new Str(140, { optional: true }),
    features: new ListOf(new Str(80), { maxItems: 8, default: [] }), cta: new Str(30, { optional: true }), highlighted: new Bool({ default: false }),
  }), { minItems: 1, maxItems: 4 }),
}, (c) => section("mf-pricing", c, [
  head(c),
  el("div", { class: c.cls("mf-grid mf-tiers", { counts: { tiers: ["mf-cols-", 4] } }) },
    c.each("tiers", (tier) => el("article", { class: tier.cls("mf-tier", { flags: { highlighted: "is-featured" } }) },
      tier.when("highlighted", () => el("span", { class: "mf-badge mf-tier__flag" }, "Most popular")),
      el("h3", null, tier.text("name")),
      el("p", { class: "mf-tier__price" }, el("span", { class: "mf-tier__amount" }, tier.text("price")),
        tier.when("period", () => el("span", { class: "mf-tier__period" }, tier.text("period")))),
      tier.when("description", () => el("p", { class: "mf-tier__desc" }, tier.text("description"))),
      el("ul", { class: "mf-tier__features" }, tier.each("features", (f) => el("li", null, f.iconNamed("check"), el("span", null, f.item())))),
      tier.when("cta", () => el("a", { class: "mf-btn", href: "#" }, tier.text("cta")))))),
]));

const FAQ = define("faq", {
  title: new Str(100),
  subtitle: new Str(240, { optional: true }),
  items: new ListOf(new Obj({ question: new Str(140), answer: new Str(500) }), { minItems: 1, maxItems: 10 }),
}, (c) => section("mf-faq-section", c, [
  head(c),
  el("div", { class: "mf-faq" }, c.each("items", (item) => el("details", { class: "mf-faq__item" }, el("summary", null, item.text("question")), el("p", null, item.text("answer"))))),
]));

const CTA = define("cta", {
  title: new Str(120), subtitle: new Str(240, { optional: true }), cta: new Str(30),
}, (c) =>
  el("section", { class: "mf-section mf-cta", id: c.text("id") },
    el("div", { class: "mf-container" },
      el("div", { class: "mf-cta__panel" },
        el("h2", null, c.text("title")),
        c.when("subtitle", () => el("p", null, c.text("subtitle"))),
        el("a", { class: "mf-btn mf-cta__btn", href: "#" }, c.text("cta"))))));

const FOOTER = define("footer", {
  brand: new Str(40),
  tagline: new Str(160, { optional: true }),
  columns: new ListOf(new Obj({ title: new Str(30), links: new ListOf(new Str(30), { maxItems: 6, default: [] }) }), { maxItems: 4, default: [] }),
  copyright: new Str(100, { optional: true }),
}, (c) =>
  el("footer", { class: "mf-footer", id: c.text("id") },
    el("div", { class: "mf-container" },
      el("div", { class: "mf-footer__top" },
        el("div", { class: "mf-footer__about" },
          el("strong", { class: "mf-footer__brand" }, c.text("brand")),
          c.when("tagline", () => el("p", { class: "mf-footer__tagline" }, c.text("tagline")))),
        el("div", { class: "mf-footer__cols" }, c.each("columns", (col) => el("div", null,
          el("h4", null, col.text("title")),
          el("ul", null, col.each("links", (l) => el("li", null, el("a", { href: "#" }, l.item())))))))),
      c.when("copyright", () => el("p", { class: "mf-footer__legal" }, c.text("copyright"))))));

export const COMPONENTS: Record<string, Component> = Object.fromEntries(
  [NAVBAR, HERO, FEATURES, CARDS, TESTIMONIALS, PRICING, FAQ, CTA, FOOTER].map((c) => [c.type, c]),
);

if (Object.keys(COMPONENTS).join() !== SECTION_TYPES.join()) throw new Error("components registry and layouts.SECTION_TYPES are out of sync");
