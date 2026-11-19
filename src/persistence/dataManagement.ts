import type { GrowthGoal } from "../growth/types";
import { MEMORY_STORAGE_KEYS } from "../memory/storage";
import type { AdaptiveMission } from "../missions/types";
import { PLANS_STORAGE_KEY } from "../planning/planningEngine";
import type { PersonalPlan } from "../planning/types";
import {
  IndexedDbMirror,
  LocalStorageAdapter,
  MemoryStorageAdapter,
  type MinimalWebStorage,
} from "./storageAdapters";
import {
  CURRENT_SCHEMA_VERSION,
  type ImportPreview,
  type IntegrityReport,
  type OperationalDataSnapshot,
  type OperationalPreferences,
  type StorageAdapter,
  type StorageRecordEnvelope,
  type TechnicalLogEntry,
} from "./types";

export const OPERATIONAL_STORAGE_KEY = "aura_operational_data_v1";
export const OPERATIONAL_BACKUP_KEY = "aura_operational_backup_v1";

function createEmptySnapshot(nowIso: string = new Date().toISOString()): OperationalDataSnapshot {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: nowIso,
    revision: 0,
    legacyMigrationCompleted: true,
    plans: [],
    missions: [],
    growthGoals: [],
    preferences: {},
  };
}

function isValidPlan(item: unknown): item is PersonalPlan {
  if (!item || typeof item !== "object") return false;
  const p = item as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.trim().length > 0 &&
    typeof p.title === "string" &&
    typeof p.declaredGoal === "string" &&
    Array.isArray(p.tasks)
  );
}

function isValidMission(item: unknown): item is AdaptiveMission {
  if (!item || typeof item !== "object") return false;
  const m = item as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.id.trim().length > 0 &&
    typeof m.title === "string" &&
    typeof m.status === "string"
  );
}

function isValidGrowthGoal(item: unknown): item is GrowthGoal {
  if (!item || typeof item !== "object") return false;
  const g = item as Record<string, unknown>;
  return (
    typeof g.id === "string" &&
    g.id.trim().length > 0 &&
    typeof g.title === "string" &&
    typeof g.status === "string"
  );
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/**
 * Validatore di integrità per i dati operativi:
 * filtra record danneggiati senza bloccare l'app e senza cancellare i record validi.
 */
export class DataIntegrityValidator {
  validateAndSanitize(raw: unknown): {
    snapshot: OperationalDataSnapshot;
    report: IntegrityReport;
  } {
    const checkedAt = new Date().toISOString();
    const issues: string[] = [];

    if (!raw || typeof raw !== "object") {
      return {
        snapshot: createEmptySnapshot(checkedAt),
        report: {
          valid: false,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          checkedAt,
          totalRecords: 0,
          validRecords: 0,
          corruptedRecords: 1,
          recoveredCount: 0,
          issues: ["Struttura dati operativa non valida o danneggiata; inizializzato stato sicuro."],
        },
      };
    }

    const obj = raw as Record<string, unknown>;
    const rawPlans = Array.isArray(obj.plans) ? obj.plans : [];
    const rawMissions = Array.isArray(obj.missions) ? obj.missions : [];
    const rawGoals = Array.isArray(obj.growthGoals) ? obj.growthGoals : [];

    const validPlans = dedupeById(rawPlans.filter(isValidPlan));
    const validMissions = dedupeById(rawMissions.filter(isValidMission));
    const validGoals = dedupeById(rawGoals.filter(isValidGrowthGoal));

    const corruptedPlans = rawPlans.length - validPlans.length;
    const corruptedMissions = rawMissions.length - validMissions.length;
    const corruptedGoals = rawGoals.length - validGoals.length;

    if (corruptedPlans > 0) issues.push(`Rimossi ${corruptedPlans} piani danneggiati o duplicati.`);
    if (corruptedMissions > 0) issues.push(`Rimosse ${corruptedMissions} missioni danneggiate o duplicate.`);
    if (corruptedGoals > 0) issues.push(`Rimossi ${corruptedGoals} obiettivi danneggiati o duplicati.`);

    const totalRecords = rawPlans.length + rawMissions.length + rawGoals.length;
    const validRecords = validPlans.length + validMissions.length + validGoals.length;
    const corruptedRecords = corruptedPlans + corruptedMissions + corruptedGoals;

    const preferences: OperationalPreferences =
      obj.preferences && typeof obj.preferences === "object"
        ? (obj.preferences as OperationalPreferences)
        : {};

    const snapshot: OperationalDataSnapshot = {
      schemaVersion:
        typeof obj.schemaVersion === "number" ? obj.schemaVersion : CURRENT_SCHEMA_VERSION,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : checkedAt,
      revision: typeof obj.revision === "number" ? obj.revision : 1,
      legacyMigrationCompleted:
        typeof obj.legacyMigrationCompleted === "boolean"
          ? obj.legacyMigrationCompleted
          : undefined,
      plans: validPlans,
      missions: validMissions,
      growthGoals: validGoals,
      preferences,
    };

    return {
      snapshot,
      report: {
        valid: corruptedRecords === 0,
        schemaVersion: snapshot.schemaVersion,
        checkedAt,
        totalRecords,
        validRecords,
        corruptedRecords,
        recoveredCount: validRecords,
        issues,
      },
    };
  }
}

/**
 * Gestore delle migrazioni di schema:
 * migra in modo idempotente dati legacy (chiavi aura_planning_v1_plans,
 * aura.memory.missions.v1, aura.memory.growth_goals.v1 e schemaVersion < 2)
 * senza perdere dati, senza creare duplicati e creando sempre un backup pre-migrazione.
 */
export class DataMigrationManager {
  private readLegacyArray(adapter: StorageAdapter, key: string): unknown[] {
    const rawStr = adapter.getItem(key);
    if (!rawStr) return [];
    try {
      const parsed = JSON.parse(rawStr);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private readLegacyOperationalData(
    adapter: StorageAdapter,
    validator: DataIntegrityValidator
  ): {
    plans: PersonalPlan[];
    missions: AdaptiveMission[];
    growthGoals: GrowthGoal[];
    hasAny: boolean;
  } {
    const rawPlans = this.readLegacyArray(adapter, PLANS_STORAGE_KEY);
    const rawMissions = this.readLegacyArray(adapter, MEMORY_STORAGE_KEYS.missions);
    const rawGoals = this.readLegacyArray(adapter, MEMORY_STORAGE_KEYS.growthGoals);

    const { snapshot } = validator.validateAndSanitize({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      plans: rawPlans,
      missions: rawMissions,
      growthGoals: rawGoals,
      preferences: {},
    });

    const hasAny =
      snapshot.plans.length > 0 ||
      snapshot.missions.length > 0 ||
      snapshot.growthGoals.length > 0;

    return {
      plans: snapshot.plans,
      missions: snapshot.missions,
      growthGoals: snapshot.growthGoals,
      hasAny,
    };
  }

  migrate(
    raw: unknown,
    adapter: StorageAdapter,
    validator: DataIntegrityValidator
  ): { snapshot: OperationalDataSnapshot; migrated: boolean; fromVersion: number } {
    const nowIso = new Date().toISOString();

    // Caso 1: nessun dato operativo presente -> prova migrazione da tutte le chiavi legacy
    if (!raw) {
      const legacy = this.readLegacyOperationalData(adapter, validator);
      if (legacy.hasAny) {
        adapter.setItem(
          OPERATIONAL_BACKUP_KEY,
          JSON.stringify({
            backedUpAt: nowIso,
            plans: legacy.plans,
            missions: legacy.missions,
            growthGoals: legacy.growthGoals,
          })
        );
        const { snapshot } = validator.validateAndSanitize({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          updatedAt: nowIso,
          revision: 1,
          legacyMigrationCompleted: true,
          plans: legacy.plans,
          missions: legacy.missions,
          growthGoals: legacy.growthGoals,
          preferences: {},
        });
        return { snapshot, migrated: true, fromVersion: 0 };
      }
      return {
        snapshot: createEmptySnapshot(nowIso),
        migrated: false,
        fromVersion: CURRENT_SCHEMA_VERSION,
      };
    }

    // Caso 2: payload esistente (v0, v1 o senza flag legacyMigrationCompleted)
    const obj = raw as Record<string, unknown>;
    const payload =
      obj.payload && typeof obj.payload === "object"
        ? (obj.payload as Record<string, unknown>)
        : obj;
    const fromVersion =
      typeof payload.schemaVersion === "number"
        ? payload.schemaVersion
        : typeof obj.schemaVersion === "number"
        ? obj.schemaVersion
        : 0;
    const alreadyMigrated =
      fromVersion >= CURRENT_SCHEMA_VERSION && payload.legacyMigrationCompleted === true;

    if (!alreadyMigrated) {
      adapter.setItem(OPERATIONAL_BACKUP_KEY, JSON.stringify(raw));
      const { snapshot: sanitizedExisting } = validator.validateAndSanitize(payload);
      const legacy = this.readLegacyOperationalData(adapter, validator);

      // Unione sicura: i dati operativi esistenti hanno precedenza, nessun duplicato e nessuna sovrascrittura con array vuoti
      const mergedPlans = dedupeById([...sanitizedExisting.plans, ...legacy.plans]);
      const mergedMissions = dedupeById([...sanitizedExisting.missions, ...legacy.missions]);
      const mergedGoals = dedupeById([...sanitizedExisting.growthGoals, ...legacy.growthGoals]);

      const snapshot: OperationalDataSnapshot = {
        ...sanitizedExisting,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        updatedAt: nowIso,
        legacyMigrationCompleted: true,
        plans: mergedPlans,
        missions: mergedMissions,
        growthGoals: mergedGoals,
      };
      return { snapshot, migrated: true, fromVersion };
    }

    const { snapshot } = validator.validateAndSanitize(payload);
    return { snapshot, migrated: false, fromVersion };
  }
}

/**
 * Repository centralizzato per i DATI OPERATIVI di AURA AI.
 * Funziona localmente anche quando il consenso alla memoria personale AI è disattivato.
 */
export class DataRepository {
  private readonly adapter: StorageAdapter;
  private readonly idbMirror = new IndexedDbMirror();
  private readonly validator = new DataIntegrityValidator();
  private readonly migrationManager = new DataMigrationManager();
  private readonly technicalLogs: TechnicalLogEntry[] = [];
  private writeLock = false;

  constructor(storage?: MinimalWebStorage | StorageAdapter | null) {
    if (storage && "isAvailable" in storage) {
      this.adapter = storage;
    } else {
      const local = new LocalStorageAdapter(storage);
      this.adapter = local.isAvailable() ? local : new MemoryStorageAdapter();
    }
  }

  private log(level: TechnicalLogEntry["level"], event: string, details?: string) {
    this.technicalLogs.unshift({
      timestamp: new Date().toISOString(),
      level,
      event,
      details,
    });
    if (this.technicalLogs.length > 50) {
      this.technicalLogs.length = 50;
    }
  }

  getStorageStatus(): {
    adapterName: string;
    indexedDbSupported: boolean;
    available: boolean;
    schemaVersion: number;
  } {
    return {
      adapterName: this.adapter.name,
      indexedDbSupported: this.idbMirror.isSupported(),
      available: this.adapter.isAvailable(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
  }

  getTechnicalLogs(): TechnicalLogEntry[] {
    return [...this.technicalLogs];
  }

  loadSnapshot(): OperationalDataSnapshot {
    const rawStr = this.adapter.getItem(OPERATIONAL_STORAGE_KEY);
    if (!rawStr) {
      const { snapshot, migrated, fromVersion } = this.migrationManager.migrate(
        null,
        this.adapter,
        this.validator
      );
      if (migrated) {
        this.log("info", "migration_completed", `from v${fromVersion} to v${CURRENT_SCHEMA_VERSION}`);
        this.persistSnapshot(snapshot, "migration");
      }
      return snapshot;
    }

    try {
      const parsed = JSON.parse(rawStr);
      const { snapshot, migrated, fromVersion } = this.migrationManager.migrate(
        parsed,
        this.adapter,
        this.validator
      );
      if (migrated) {
        this.log("info", "migration_completed", `from v${fromVersion} to v${CURRENT_SCHEMA_VERSION}`);
        this.persistSnapshot(snapshot, "migration");
      }
      return snapshot;
    } catch {
      this.log("warn", "corrupted_storage_detected", "Attempting safe backup recovery");
      const backupStr = this.adapter.getItem(OPERATIONAL_BACKUP_KEY);
      if (backupStr) {
        try {
          const parsedBackup = JSON.parse(backupStr);
          const { snapshot } = this.validator.validateAndSanitize(
            parsedBackup.payload ?? parsedBackup
          );
          this.log("info", "backup_recovered");
          return snapshot;
        } catch {
          // fallback a stato pulito
        }
      }
      return createEmptySnapshot();
    }
  }

  persistSnapshot(
    snapshot: OperationalDataSnapshot,
    source: StorageRecordEnvelope<OperationalDataSnapshot>["source"] = "user"
  ): OperationalDataSnapshot {
    if (this.writeLock) {
      this.log("warn", "concurrent_write_prevented");
      return snapshot;
    }
    this.writeLock = true;
    try {
      const nowIso = new Date().toISOString();
      const nextSnapshot: OperationalDataSnapshot = {
        ...snapshot,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        updatedAt: nowIso,
        revision: (snapshot.revision ?? 0) + 1,
        legacyMigrationCompleted: true,
        plans: dedupeById(snapshot.plans),
        missions: dedupeById(snapshot.missions),
        growthGoals: dedupeById(snapshot.growthGoals),
      };

      const envelope: StorageRecordEnvelope<OperationalDataSnapshot> = {
        id: OPERATIONAL_STORAGE_KEY,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: nextSnapshot.updatedAt,
        updatedAt: nowIso,
        revision: nextSnapshot.revision,
        source,
        status: "active",
        domain: "operational",
        payload: nextSnapshot,
      };

      const serialized = JSON.stringify(envelope);
      const existing = this.adapter.getItem(OPERATIONAL_STORAGE_KEY);
      if (existing) {
        this.adapter.setItem(OPERATIONAL_BACKUP_KEY, existing);
      }
      this.adapter.setItem(OPERATIONAL_STORAGE_KEY, serialized);
      void this.idbMirror.put(OPERATIONAL_STORAGE_KEY, serialized);
      this.log("info", "snapshot_saved", `rev=${nextSnapshot.revision}`);
      return nextSnapshot;
    } finally {
      this.writeLock = false;
    }
  }

  getPlans(): PersonalPlan[] {
    return this.loadSnapshot().plans;
  }

  savePlans(plans: PersonalPlan[]): OperationalDataSnapshot {
    const current = this.loadSnapshot();
    return this.persistSnapshot({ ...current, plans });
  }

  getMissions(): AdaptiveMission[] {
    return this.loadSnapshot().missions;
  }

  saveMissions(missions: AdaptiveMission[]): OperationalDataSnapshot {
    const current = this.loadSnapshot();
    return this.persistSnapshot({ ...current, missions });
  }

  getGrowthGoals(): GrowthGoal[] {
    return this.loadSnapshot().growthGoals;
  }

  saveGrowthGoals(growthGoals: GrowthGoal[]): OperationalDataSnapshot {
    const current = this.loadSnapshot();
    return this.persistSnapshot({ ...current, growthGoals });
  }

  savePreferences(preferences: OperationalPreferences): OperationalDataSnapshot {
    const current = this.loadSnapshot();
    return this.persistSnapshot({
      ...current,
      preferences: { ...current.preferences, ...preferences },
    });
  }

  verifyIntegrity(): IntegrityReport {
    const rawStr = this.adapter.getItem(OPERATIONAL_STORAGE_KEY);
    if (!rawStr) {
      return {
        valid: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        checkedAt: new Date().toISOString(),
        totalRecords: 0,
        validRecords: 0,
        corruptedRecords: 0,
        recoveredCount: 0,
        issues: [],
      };
    }
    try {
      const parsed = JSON.parse(rawStr);
      const { report } = this.validator.validateAndSanitize(parsed.payload ?? parsed);
      return report;
    } catch {
      return {
        valid: false,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        checkedAt: new Date().toISOString(),
        totalRecords: 0,
        validRecords: 0,
        corruptedRecords: 1,
        recoveredCount: 0,
        issues: ["JSON nello storage operativo non leggibile."],
      };
    }
  }

  deleteOperationalData(confirmed: boolean): boolean {
    if (!confirmed) {
      this.log("warn", "delete_blocked_missing_confirmation");
      return false;
    }
    this.adapter.removeItem(OPERATIONAL_STORAGE_KEY);
    this.adapter.removeItem(OPERATIONAL_BACKUP_KEY);
    this.adapter.removeItem(PLANS_STORAGE_KEY);
    void this.idbMirror.delete(OPERATIONAL_STORAGE_KEY);
    this.log("info", "operational_data_deleted");
    return true;
  }
}

/**
 * Gestore esportazione separata: dati operativi vs memoria personale AI (solo con consenso).
 */
export class DataExportManager {
  exportOperationalJson(repo: DataRepository): string {
    const snapshot = repo.loadSnapshot();
    return JSON.stringify(
      {
        exportType: "aura_operational_data",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        data: snapshot,
      },
      null,
      2
    );
  }

  exportAiMemoryJson(consentEnabled: boolean, memoryBundle: unknown): string {
    if (!consentEnabled) {
      throw new Error(
        "Esportazione memoria AI bloccata: il consenso alla memoria personale non è attivo."
      );
    }
    return JSON.stringify(
      {
        exportType: "aura_ai_personal_memory",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        consentEnabled: true,
        data: memoryBundle,
      },
      null,
      2
    );
  }
}

/**
 * Gestore importazione con validazione schema, anteprima, rilevamento duplicati e conferma sovrascrittura.
 */
export class DataImportManager {
  private readonly validator = new DataIntegrityValidator();

  previewImport(rawJson: string, currentSnapshot: OperationalDataSnapshot): ImportPreview {
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== "object") {
        return {
          valid: false,
          schemaVersion: 0,
          error: "Il file JSON non contiene un oggetto valido.",
          incomingPlans: 0,
          incomingMissions: 0,
          incomingGoals: 0,
          duplicatePlanIds: [],
          duplicateMissionIds: [],
          duplicateGoalIds: [],
          willOverwriteExisting: false,
        };
      }

      const candidate =
        parsed.exportType === "aura_operational_data" && parsed.data
          ? parsed.data
          : parsed.payload ?? parsed;

      if (
        !Array.isArray(candidate.plans) &&
        !Array.isArray(candidate.missions) &&
        !Array.isArray(candidate.growthGoals)
      ) {
        return {
          valid: false,
          schemaVersion: 0,
          error: "Schema non compatibile: mancano le sezioni operative (plans, missions, growthGoals).",
          incomingPlans: 0,
          incomingMissions: 0,
          incomingGoals: 0,
          duplicatePlanIds: [],
          duplicateMissionIds: [],
          duplicateGoalIds: [],
          willOverwriteExisting: false,
        };
      }

      const { snapshot } = this.validator.validateAndSanitize(candidate);
      const currentPlanIds = new Set(currentSnapshot.plans.map((p) => p.id));
      const currentMissionIds = new Set(currentSnapshot.missions.map((m) => m.id));
      const currentGoalIds = new Set(currentSnapshot.growthGoals.map((g) => g.id));

      const duplicatePlanIds = snapshot.plans
        .filter((p) => currentPlanIds.has(p.id))
        .map((p) => p.id);
      const duplicateMissionIds = snapshot.missions
        .filter((m) => currentMissionIds.has(m.id))
        .map((m) => m.id);
      const duplicateGoalIds = snapshot.growthGoals
        .filter((g) => currentGoalIds.has(g.id))
        .map((g) => g.id);

      const hasExisting =
        currentSnapshot.plans.length > 0 ||
        currentSnapshot.missions.length > 0 ||
        currentSnapshot.growthGoals.length > 0;

      return {
        valid: true,
        schemaVersion: snapshot.schemaVersion,
        incomingPlans: snapshot.plans.length,
        incomingMissions: snapshot.missions.length,
        incomingGoals: snapshot.growthGoals.length,
        duplicatePlanIds,
        duplicateMissionIds,
        duplicateGoalIds,
        willOverwriteExisting: hasExisting,
        snapshot,
      };
    } catch {
      return {
        valid: false,
        schemaVersion: 0,
        error: "JSON non valido o malformato.",
        incomingPlans: 0,
        incomingMissions: 0,
        incomingGoals: 0,
        duplicatePlanIds: [],
        duplicateMissionIds: [],
        duplicateGoalIds: [],
        willOverwriteExisting: false,
      };
    }
  }

  applyImport(
    repo: DataRepository,
    preview: ImportPreview,
    options: { mode: "merge" | "overwrite"; confirmed: boolean }
  ): OperationalDataSnapshot {
    if (!preview.valid || !preview.snapshot) {
      throw new Error(preview.error ?? "Anteprima di importazione non valida.");
    }
    if (options.mode === "overwrite" && preview.willOverwriteExisting && !options.confirmed) {
      throw new Error("Conferma esplicita richiesta prima di sovrascrivere i dati esistenti.");
    }

    const current = repo.loadSnapshot();
    if (options.mode === "overwrite") {
      return repo.persistSnapshot(preview.snapshot, "import");
    }

    // Merge deduplicato per ID
    return repo.persistSnapshot(
      {
        ...current,
        plans: dedupeById([...preview.snapshot.plans, ...current.plans]),
        missions: dedupeById([...preview.snapshot.missions, ...current.missions]),
        growthGoals: dedupeById([...preview.snapshot.growthGoals, ...current.growthGoals]),
        preferences: { ...current.preferences, ...preview.snapshot.preferences },
      },
      "import"
    );
  }
}
