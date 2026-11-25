import { useCallback, useEffect, useState } from "react";
import type { ApiProductOnboardingSession } from "../api/client";
import { HomeLandingView } from "../features/home/HomeLandingView";
import { OnboardingSessionView } from "../features/home/OnboardingSessionView";
import "./HomePage.css";

export function HomePage({
  sessionId,
  navigate,
}: {
  sessionId?: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  const [freshSession, setFreshSession] = useState<ApiProductOnboardingSession | null>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = sessionId ? "新品建档 · PicAgent" : "首页 · PicAgent";
    return () => {
      document.title = previous;
    };
  }, [sessionId]);

  const handleSessionCreated = useCallback(
    (created: ApiProductOnboardingSession) => {
      setFreshSession(created);
      navigate(`/?session=${encodeURIComponent(created.id)}`);
    },
    [navigate],
  );

  const handleConsumeInitialSession = useCallback(() => {
    setFreshSession(null);
  }, []);

  if (sessionId) {
    return (
      <OnboardingSessionView
        key={sessionId}
        sessionId={sessionId}
        initialSession={freshSession}
        onConsumeInitialSession={handleConsumeInitialSession}
        navigate={navigate}
      />
    );
  }

  return <HomeLandingView navigate={navigate} onSessionCreated={handleSessionCreated} />;
}
