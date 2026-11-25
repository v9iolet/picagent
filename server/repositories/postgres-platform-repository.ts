import type { Pool } from "pg";
import { defaultDetailSizePresets, type DetailSizePresets } from "../../shared/aplus.js";
import type { PlatformProfile, PlatformRepository } from "../types.js";

const columns = `code, name, to_jsonb(platform_profiles)->'listing_copy_rules' AS "listingCopyRules", to_jsonb(platform_profiles)->'detail_size_presets' AS "detailSizePresets", market_scope AS "marketScope", main_image_background AS "mainImageBackground", main_image_strategy AS "mainImageStrategy", gallery_strategy AS "galleryStrategy", text_strategy AS "textStrategy", model_strategy AS "modelStrategy", source_note AS "sourceNote", sort_order AS "sortOrder"`;

type PlatformRow = Omit<PlatformProfile, "detailSizePresets"> & { detailSizePresets: DetailSizePresets | null };

function toPlatformProfile(row: PlatformRow): PlatformProfile {
  return { ...row, detailSizePresets: row.detailSizePresets ?? defaultDetailSizePresets(row.code, row.marketScope) };
}

export class PostgresPlatformRepository implements PlatformRepository {
  constructor(private readonly pool: Pool) {}

  async listEnabled(): Promise<PlatformProfile[]> {
    const result = await this.pool.query<PlatformRow>(`SELECT ${columns} FROM suite_workbench.platform_profiles WHERE enabled = true ORDER BY sort_order, name`);
    return result.rows.map(toPlatformProfile);
  }

  async find(value: string): Promise<PlatformProfile | null> {
    const result = await this.pool.query<PlatformRow>(`SELECT ${columns} FROM suite_workbench.platform_profiles WHERE enabled = true AND (code = $1 OR name = $1 OR $1 LIKE name || ' %') LIMIT 1`, [value.trim()]);
    return result.rows[0] ? toPlatformProfile(result.rows[0]) : null;
  }
}
