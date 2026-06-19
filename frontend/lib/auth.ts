"use client";
import type { Tenant, TokenResponse } from "./types";

export function saveSession(data: TokenResponse): void {
  localStorage.setItem("access_token", data.access_token);
  localStorage.setItem("tenant", JSON.stringify(data.tenant));
}

export function clearSession(): void {
  localStorage.removeItem("access_token");
  localStorage.removeItem("tenant");
}

export function getStoredTenant(): Tenant | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("tenant");
  return raw ? (JSON.parse(raw) as Tenant) : null;
}

export function isAuthenticated(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(localStorage.getItem("access_token"));
}
