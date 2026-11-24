import type { MouseEvent, ReactNode } from "react";
import { Icon } from "../pages/shared";
import "./AppShell.css";

export type AppNavSection = "create" | "products" | "assets" | "templates" | "settings";

export interface AppCrumb {
  label: string;
  to?: string;
}

export function AppShell({
  activeNav,
  navigate,
  crumbs,
  centerSlot,
  rightSlot,
  statusText = "实时已同步",
  statusTone = "pass",
  fullHeight = false,
  className = "",
  children,
}: {
  activeNav: AppNavSection;
  navigate: (to: string) => void;
  crumbs: AppCrumb[];
  centerSlot?: ReactNode;
  rightSlot?: ReactNode;
  statusText?: string;
  statusTone?: "pass" | "running" | "error";
  fullHeight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const linkTo = (to: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };

  const navItems: Array<{ key: AppNavSection; label: string; to: string; icon: string }> = [
    { key: "create", label: "创建", to: "/create/suite", icon: "sparkles" },
    { key: "products", label: "商品库", to: "/products", icon: "box" },
    { key: "assets", label: "图片库", to: "/assets", icon: "image" },
    { key: "templates", label: "模板库", to: "/templates", icon: "files" },
    { key: "settings", label: "配置", to: "/settings", icon: "sliders" },
  ];

  return (
    <div className={`pa-shell ${fullHeight ? "pa-shell-full" : ""} ${className}`}>
      <header className="pa-topbar">
        <div className="pa-topbar-left">
          <a className="pa-brand" href="/create/suite" onClick={linkTo("/create/suite")} title="PicAgent 工作台首页">
            <img src="/logo.png" alt="" width={28} height={28} />
            <strong>PicAgent</strong>
          </a>
          <nav className="pa-breadcrumbs" aria-label="面包屑">
            {crumbs.map((crumb, index) => (
              <span className="pa-crumb" key={`${crumb.label}-${index}`}>
                {index > 0 && <span className="pa-crumb-sep" aria-hidden="true">/</span>}
                {crumb.to ? (
                  <a href={crumb.to} onClick={linkTo(crumb.to)}>{crumb.label}</a>
                ) : (
                  <strong>{crumb.label}</strong>
                )}
              </span>
            ))}
          </nav>
        </div>
        <div className="pa-topbar-center">{centerSlot}</div>
        <div className="pa-topbar-right">
          {rightSlot}
          <span className={`pa-status-pill is-${statusTone}`} role="status">
            <i aria-hidden="true" />
            <span>{statusText}</span>
          </span>
        </div>
      </header>
      <aside className="pa-rail" aria-label="主导航">
        {navItems.map((item) => (
          <a
            key={item.key}
            className={`pa-rail-item ${activeNav === item.key ? "is-active" : ""}`}
            href={item.to}
            aria-current={activeNav === item.key ? "page" : undefined}
            onClick={linkTo(item.to)}
            title={item.label}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </a>
        ))}
      </aside>
      <div className={`pa-content ${fullHeight ? "pa-content-full" : ""}`}>
        {children}
      </div>
    </div>
  );
}
