import { useEffect, useState } from "react";
import { api, type AIAgent, type CollaborationDetail, type CollaborationExperiences, type CollaborationSettings, type CollaborationSummary } from "@/lib/api";
import { isActive } from "./workspace";

const documentVisible = () => document.visibilityState !== "hidden";

// Schedule after completion so slow requests cannot overlap. Returning to this
// document refreshes immediately instead of waiting out a background timer.
function pollWhileVisible(request: () => Promise<number>, initialDelay = 0) {
  let live = true, pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    clearTimeout(timer);
    if (!live || pending || !documentVisible()) return;
    pending = true;
    let delay = 30000;
    try { delay = await request(); }
    finally {
      pending = false;
      if (live && documentVisible()) timer = setTimeout(() => void poll(), delay);
    }
  }
  function onVisibility() {
    clearTimeout(timer);
    if (documentVisible()) void poll();
  }
  document.addEventListener("visibilitychange", onVisibility);
  if (documentVisible()) timer = setTimeout(() => void poll(), initialDelay);
  return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
}

export function useCollaborationWorkspace(selected: string, offset: number, query: string, refresh: number, experienceActive: boolean) {
  const [settings, setSettings] = useState<CollaborationSettings | null>(null);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [boards, setBoards] = useState<CollaborationSummary[]>([]);
  const [detail, setDetail] = useState<CollaborationDetail | null>(null);
  const [experiences, setExperiences] = useState<CollaborationExperiences | null>(null);
  const [configError, setConfigError] = useState("");
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [experienceError, setExperienceError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api.ai.collaboration.settings(), api.ai.agents.list()]).then(([config, list]) => {
      if (live) { setSettings(config); setAgents(list); setConfigError(""); }
    }).catch(error => { if (live) { setSettings(null); setAgents([]); setConfigError(String(error)); } });
    return () => { live = false; };
  }, [refresh]);
  useEffect(() => {
    let live = true;
    const stop = pollWhileVisible(async () => {
      try {
        const rows = await api.ai.collaboration.boards(offset);
        if (live) { setBoards(rows); setListError(""); }
        return rows.some(isActive) ? 3000 : 30000;
      } catch (error) {
        if (live) { setBoards([]); setListError(String(error)); }
        return 30000;
      }
    });
    return () => { live = false; stop(); };
  }, [offset, refresh]);
  useEffect(() => {
    let live = true;
    setDetail(null); setDetailError(""); setUpdatedAt(null);
    if (!selected) return;
    const stop = pollWhileVisible(async () => {
      try {
        const value = await api.ai.collaboration.board(selected);
        if (live) { setDetail(value); setDetailError(""); setUpdatedAt(Date.now()); }
        return isActive(value) ? 3000 : 30000;
      } catch (error) {
        if (live) { setDetail(null); setDetailError(String(error)); setUpdatedAt(null); }
        return 30000;
      }
    });
    return () => { live = false; stop(); };
  }, [selected, refresh]);
  useEffect(() => {
    let live = true;
    setExperiences(null); setExperienceError("");
    if (!experienceActive) return;
    const stop = pollWhileVisible(async () => {
      try { const value = await api.ai.collaboration.experiences(query); if (live) { setExperiences(value); setExperienceError(""); } }
      catch (error) { if (live) { setExperiences(null); setExperienceError(String(error)); } }
      return 15000;
    }, 250);
    return () => { live = false; stop(); };
  }, [query, refresh, experienceActive]);
  return { settings, agents, boards, detail, experiences, configError, listError, detailError, experienceError, updatedAt };
}
