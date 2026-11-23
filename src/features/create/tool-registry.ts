export const createTools = [
  { id: "suite", label: "商品套图", path: "/create/suite", icon: "image" },
  { id: "canvas", label: "生图画布", path: "/create/canvas", icon: "columns" },
  { id: "replica", label: "爆品图复刻", path: "/create/replica", icon: "compare" },
] as const;

export type CreateToolId = (typeof createTools)[number]["id"];
