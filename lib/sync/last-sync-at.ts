/**
 * Advertiser.lastSyncAt 헬퍼
 *
 * 책임:
 *   - sync 종류별 마지막 시각을 JSON 맵으로 누적 갱신 (recordSyncAt)
 *   - UI 표시용 조회 (getLastSyncAt)
 *
 * 데이터 모델:
 *   Advertiser.lastSyncAt JSONB NOT NULL DEFAULT '{}'
 *   shape: { [kind: SyncKind]: ISO_TIMESTAMP_STRING }
 *   예) { "campaigns": "2026-04-29T05:00:00.000Z", "keywords": "..." }
 *
 * 동시성:
 *   - dev 환경 단일 사용자 가정 — read → spread → write 의 race condition 무시.
 *   - 운영 단계에서 멀티 사용자 / 멀티 cron 동시 sync 시 다른 키를 덮어쓸 수 있음.
 *     UI 표시용 메타라 위험 낮으나, 빈도 높아지면 PG JSONB 함수 (jsonb_set) 로
 *     atomic update 로 전환 권고.
 *
 * 호출 위치:
 *   - 5개 sync action 의 happy path 마지막 (DB upsert 끝나고 return 직전)
 *   - cron route 의 광고주별 5단계 sync 직렬 호출 후 (또는 sync action 내부에서 자동 호출)
 */

import { prisma } from "@/lib/db/prisma"

export type SyncKind =
  | "campaigns"
  | "adgroups"
  | "keywords"
  | "ads"
  | "extensions"
  | "stat_daily"

/** SyncKind 의 모든 값 (런타임 enum 보강 — 호출부 typo 가드). */
export const SYNC_KINDS: readonly SyncKind[] = [
  "campaigns",
  "adgroups",
  "keywords",
  "ads",
  "extensions",
  "stat_daily",
] as const

/**
 * 동기화 시각 갱신 (sync 종류 1건).
 *
 * 동작:
 *   1. 현재 lastSyncAt JSON 읽기 (광고주 1행 select)
 *   2. 비-객체 / null 이면 빈 객체로 폴백 (JSONB 컬럼이지만 외부 변조 방어)
 *   3. spread + kind 키 덮어쓰기
 *   4. update lastSyncAt
 *
 * race condition: dev 환경 가정으로 무시 (위 모듈 docstring 참조).
 *
 * @param advertiserId  Advertiser.id (cuid)
 * @param kind          동기화 종류 (campaigns / adgroups / keywords / ads / extensions)
 * @param now           기록할 시각 (기본 new Date()) — 테스트 / 백필 시 주입
 */
export async function recordSyncAt(
  advertiserId: string,
  kind: SyncKind,
  now: Date = new Date(),
): Promise<void> {
  const row = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: { lastSyncAt: true },
  })

  // 광고주 미존재 시 silently no-op (sync action 진입부에서 이미 검증됨).
  if (!row) return

  const current =
    row.lastSyncAt && typeof row.lastSyncAt === "object" && !Array.isArray(row.lastSyncAt)
      ? (row.lastSyncAt as Record<string, string>)
      : {}

  const next: Record<string, string> = {
    ...current,
    [kind]: now.toISOString(),
  }

  await prisma.advertiser.update({
    where: { id: advertiserId },
    data: { lastSyncAt: next },
  })
}

/**
 * UI 표시용 lastSyncAt 조회.
 *
 *   - 광고주 미존재 / lastSyncAt 비-객체 시 빈 객체 반환 (UI 안전)
 *   - 키 누락은 정상 케이스 (해당 sync 미실행) — 호출부가 Optional 처리
 *   - 인증 / 광고주 권한 검증은 호출부 책임 (본 헬퍼는 read-only 단순 조회)
 *
 * @returns { campaigns?: ISO, adgroups?: ISO, keywords?: ISO, ads?: ISO, extensions?: ISO }
 */
export async function getLastSyncAt(
  advertiserId: string,
): Promise<Record<string, string>> {
  const row = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: { lastSyncAt: true },
  })

  if (!row) return {}

  if (
    row.lastSyncAt &&
    typeof row.lastSyncAt === "object" &&
    !Array.isArray(row.lastSyncAt)
  ) {
    return row.lastSyncAt as Record<string, string>
  }

  return {}
}
