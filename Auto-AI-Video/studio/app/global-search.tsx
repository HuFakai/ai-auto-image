"use client";

import { Bookmark, Search, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

type Result = { type: string; id: string; title: string; detail: string; href: string };
const storageKey = "pixelle.saved-searches.v1";

export function GlobalSearch() {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]); const [saved, setSaved] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { return []; }
  });
  useEffect(() => {
    if (query.trim().length < 2) return;
    const controller = new AbortController(); const timer = window.setTimeout(async () => {
      try { const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal }); if (response.ok) setResults((await response.json()).results || []); } catch { /* next query retries */ }
    }, 240);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);
  function persist(next: string[]) { setSaved(next); localStorage.setItem(storageKey, JSON.stringify(next)); }
  return <div className="global-search">
    <button className="global-search-launch" onClick={() => setOpen(!open)}><Search size={14} />全局搜索</button>
    {open ? <section className="global-search-popover" aria-label="全局搜索与保存筛选">
      <header><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索频道、选题、来源、队列、成片…" /><button onClick={() => setOpen(false)} aria-label="关闭"><X size={13} /></button></header>
      {query.trim().length >= 2 ? <button className="save-search" onClick={() => { const value = query.trim(); if (!saved.includes(value)) persist([value, ...saved].slice(0, 12)); }}><Bookmark size={12} />保存当前筛选</button> : null}
      {saved.length ? <div className="saved-searches">{saved.map((item) => <span key={item}><button onClick={() => setQuery(item)}>{item}</button><button aria-label={`删除筛选 ${item}`} onClick={() => persist(saved.filter((value) => value !== item))}><Trash2 size={10} /></button></span>)}</div> : null}
      <div className="global-search-results">{query.trim().length >= 2 ? results.map((item) => <a href={item.href} key={`${item.type}:${item.id}`} onClick={() => setOpen(false)}><small>{item.type}</small><strong>{item.title}</strong><p>{item.detail}</p></a>) : null}{query.length >= 2 && !results.length ? <p className="search-empty">没有匹配结果</p> : null}</div>
    </section> : null}
  </div>;
}
