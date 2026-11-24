import { createTools, type CreateToolId } from "./tool-registry";
import { Icon } from "../../pages/shared";

export function CreateToolsNav({
  activeTool,
  navigate,
}: {
  activeTool: CreateToolId;
  navigate: (to: string) => void;
}) {
  return (
    <nav className="ss-tools" aria-label="创作功能">
      {createTools.map((tool) => (
        <a
          key={tool.id}
          href={tool.path}
          aria-current={tool.id === activeTool ? "page" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate(tool.path);
          }}
        >
          <Icon name={tool.icon} />
          {tool.label}
        </a>
      ))}
    </nav>
  );
}
