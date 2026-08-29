"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

export function Pagination({ page, pageSize, total, onPage }: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return <nav className="pagination" aria-label="分页导航">
    <span>{start}–{end} / {total}</span>
    <div><button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} aria-label="上一页"><ChevronLeft size={14} /></button><strong>{String(page).padStart(2, "0")} <small>/ {String(pages).padStart(2, "0")}</small></strong><button onClick={() => onPage(Math.min(pages, page + 1))} disabled={page >= pages} aria-label="下一页"><ChevronRight size={14} /></button></div>
  </nav>;
}
