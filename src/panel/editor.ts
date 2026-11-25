// Schema for the Elementor-style property panel (Style / Layout / Advanced tabs).

export type FieldType = "color" | "text" | "select" | "range";

export interface EditableField {
  prop: string;
  label: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
}
export interface EditGroup {
  title: string;
  fields: EditableField[];
}
export interface EditTab {
  id: string;
  label: string;
  groups: EditGroup[];
}

export const EDIT_TABS: EditTab[] = [
  {
    id: "style",
    label: "Style",
    groups: [
      {
        title: "Typography",
        fields: [
          { prop: "font-size", label: "Size", type: "text", placeholder: "16px" },
          {
            prop: "font-weight",
            label: "Weight",
            type: "select",
            options: ["", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
          },
          { prop: "line-height", label: "Line height", type: "text", placeholder: "1.5" },
          { prop: "letter-spacing", label: "Letter sp.", type: "text", placeholder: "0" },
          {
            prop: "text-align",
            label: "Align",
            type: "select",
            options: ["", "left", "center", "right", "justify"],
          },
          {
            prop: "text-transform",
            label: "Transform",
            type: "select",
            options: ["", "none", "uppercase", "lowercase", "capitalize"],
          },
          { prop: "font-family", label: "Font", type: "text", placeholder: "Inter, sans-serif" },
        ],
      },
      {
        title: "Color",
        fields: [
          { prop: "color", label: "Text", type: "color" },
          { prop: "background-color", label: "Background", type: "color" },
        ],
      },
      {
        title: "Border",
        fields: [
          { prop: "border-radius", label: "Radius", type: "text", placeholder: "8px" },
          { prop: "border-width", label: "Width", type: "text", placeholder: "1px" },
          {
            prop: "border-style",
            label: "Style",
            type: "select",
            options: ["", "none", "solid", "dashed", "dotted"],
          },
          { prop: "border-color", label: "Color", type: "color" },
          { prop: "box-shadow", label: "Shadow", type: "text", placeholder: "0 4px 12px rgba(0,0,0,.2)" },
        ],
      },
    ],
  },
  {
    id: "layout",
    label: "Layout",
    groups: [
      {
        title: "Display",
        fields: [
          {
            prop: "display",
            label: "Display",
            type: "select",
            options: ["", "block", "flex", "inline-flex", "grid", "inline-block", "none"],
          },
          {
            prop: "flex-direction",
            label: "Direction",
            type: "select",
            options: ["", "row", "row-reverse", "column", "column-reverse"],
          },
          {
            prop: "justify-content",
            label: "Justify",
            type: "select",
            options: ["", "flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"],
          },
          {
            prop: "align-items",
            label: "Align",
            type: "select",
            options: ["", "stretch", "flex-start", "center", "flex-end", "baseline"],
          },
          { prop: "gap", label: "Gap", type: "text", placeholder: "16px" },
        ],
      },
      {
        title: "Spacing & size",
        fields: [
          { prop: "padding", label: "Padding", type: "text", placeholder: "16px" },
          { prop: "margin", label: "Margin", type: "text", placeholder: "0" },
          { prop: "width", label: "Width", type: "text", placeholder: "auto" },
          { prop: "height", label: "Height", type: "text", placeholder: "auto" },
        ],
      },
    ],
  },
  {
    id: "advanced",
    label: "Advanced",
    groups: [
      {
        title: "Effects",
        fields: [
          { prop: "opacity", label: "Opacity", type: "range" },
          { prop: "z-index", label: "Z-index", type: "text", placeholder: "auto" },
          { prop: "transform", label: "Transform", type: "text", placeholder: "scale(1.05)" },
          { prop: "transition", label: "Transition", type: "text", placeholder: "all .2s ease" },
          { prop: "filter", label: "Filter", type: "text", placeholder: "blur(4px)" },
        ],
      },
    ],
  },
];

export function colorToHex(input: string): string {
  const s = (input || "").trim().toLowerCase();
  if (s[0] === "#") return s.length === 4 ? "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s.slice(0, 7);
  if (s === "white") return "#ffffff";
  if (s === "black") return "#000000";
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return "#000000";
  const p = m[1].split(/[,/\s]+/).filter(Boolean);
  const h = (n: string) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, "0");
  return p.length >= 3 ? "#" + h(p[0]) + h(p[1]) + h(p[2]) : "#000000";
}
