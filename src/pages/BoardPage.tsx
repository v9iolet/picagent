import { WorkbenchBoardPage } from "./WorkbenchBoardPage";

export function BoardPage(props: { suiteId: string; navigate: (to: string) => void }) {
  return <WorkbenchBoardPage {...props} />;
}
