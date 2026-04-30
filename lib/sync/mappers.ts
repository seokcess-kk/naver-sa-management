/**
 * 네이버 SA 응답 → 앱 enum 매핑 (sync 공용)
 *
 * 책임:
 *   - status (CampaignStatus / AdGroupStatus / KeywordStatus / AdStatus / AdExtensionStatus) 매핑
 *   - inspectStatus (InspectStatus) 매핑
 *
 * 본 모듈은 sync 액션 / cron 양쪽에서 공유되는 순수 함수만 둠.
 *
 * 매핑 정책 공통:
 *   status:
 *     - status='DELETED' (또는 deleted=true) → 'deleted'
 *     - userLock=true                        → 'off'
 *     - status='PAUSED'                      → 'off'
 *     - 그 외                                → 'on'
 *   inspectStatus:
 *     - APPROVED / PASSED / OK / ELIGIBLE → approved
 *     - REJECTED / FAILED / DENIED        → rejected
 *     - 그 외 (UNDER_REVIEW / 누락)       → pending
 *
 * 기존 정책은 5개 actions.ts (campaigns / adgroups / keywords / ads / extensions) 에 동일하게
 * 정의되어 있었음 — 본 모듈로 통합. 호출부에서는 단일 import 로 재사용.
 */

import type {
  AdExtensionStatus,
  AdGroupStatus,
  AdStatus,
  CampaignStatus,
  InspectStatus,
  KeywordStatus,
} from "@/lib/generated/prisma/client"

/** 공통 status 응답 shape (SA 응답 모듈 별 union 검사용 narrow 타입). */
type StatusShape = {
  userLock?: boolean
  status?: string
  deleted?: boolean
}

/** 공통 status 매핑 — on/off/deleted 결정. */
function mapStatusGeneric(s: StatusShape): "on" | "off" | "deleted" {
  if (s.deleted === true) return "deleted"
  if (typeof s.status === "string" && s.status.toUpperCase() === "DELETED") {
    return "deleted"
  }
  if (s.userLock === true) return "off"
  if (typeof s.status === "string" && s.status.toUpperCase() === "PAUSED") {
    return "off"
  }
  return "on"
}

export function mapCampaignStatus(c: unknown): CampaignStatus {
  return mapStatusGeneric(c as StatusShape) as CampaignStatus
}

export function mapAdGroupStatus(g: unknown): AdGroupStatus {
  return mapStatusGeneric(g as StatusShape) as AdGroupStatus
}

export function mapKeywordStatus(k: unknown): KeywordStatus {
  return mapStatusGeneric(k as StatusShape) as KeywordStatus
}

export function mapAdStatus(a: unknown): AdStatus {
  return mapStatusGeneric(a as StatusShape) as AdStatus
}

export function mapExtensionStatus(e: unknown): AdExtensionStatus {
  return mapStatusGeneric(e as StatusShape) as AdExtensionStatus
}

/** 공통 inspectStatus 매핑. */
export function mapInspectStatus(item: {
  inspectStatus?: string | null
}): InspectStatus {
  const raw = (item.inspectStatus ?? "").toString().toUpperCase().trim()
  if (
    raw === "APPROVED" ||
    raw === "PASSED" ||
    raw === "OK" ||
    raw === "ELIGIBLE"
  ) {
    return "approved"
  }
  if (raw === "REJECTED" || raw === "FAILED" || raw === "DENIED") {
    return "rejected"
  }
  return "pending"
}
