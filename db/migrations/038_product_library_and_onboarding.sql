CREATE TABLE IF NOT EXISTS suite_workbench.product_cards (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'archived')),
  name text NOT NULL CHECK (char_length(trim(name)) > 0 AND char_length(name) <= 120),
  category text NOT NULL CHECK (char_length(trim(category)) > 0 AND char_length(category) <= 60),
  selling_points_json jsonb NOT NULL CHECK (
    jsonb_typeof(selling_points_json) = 'array'
    AND jsonb_array_length(selling_points_json) BETWEEN 1 AND 10
  ),
  specifications text NOT NULL CHECK (char_length(trim(specifications)) > 0 AND char_length(specifications) <= 1000),
  materials_craft text NOT NULL CHECK (char_length(trim(materials_craft)) > 0 AND char_length(materials_craft) <= 800),
  audience_scenarios text NOT NULL CHECK (char_length(trim(audience_scenarios)) > 0 AND char_length(audience_scenarios) <= 800),
  package_contents text NOT NULL CHECK (char_length(trim(package_contents)) > 0 AND char_length(package_contents) <= 600),
  sku_code text NOT NULL DEFAULT '' CHECK (char_length(sku_code) <= 80),
  pain_points_comparison text NOT NULL DEFAULT '' CHECK (char_length(pain_points_comparison) <= 1000),
  usage_demo_highlights text NOT NULL DEFAULT '' CHECK (char_length(usage_demo_highlights) <= 1000),
  certifications_prohibitions text NOT NULL DEFAULT '' CHECK (char_length(certifications_prohibitions) <= 800),
  source_session_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_cards_status_updated_idx
  ON suite_workbench.product_cards (status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS product_cards_updated_idx
  ON suite_workbench.product_cards (updated_at DESC, id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'suite_workbench' AND table_name = 'product_cards' AND column_name = 'sku_code'
  ) THEN
    CREATE INDEX IF NOT EXISTS product_cards_sku_lower_idx
      ON suite_workbench.product_cards (lower(sku_code))
      WHERE sku_code <> '';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'suite_workbench' AND table_name = 'product_cards' AND column_name = 'category'
  ) THEN
    CREATE INDEX IF NOT EXISTS product_cards_category_lower_idx
      ON suite_workbench.product_cards (lower(category));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS suite_workbench.product_card_images (
  id uuid PRIMARY KEY,
  product_card_id uuid NOT NULL REFERENCES suite_workbench.product_cards(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  original_object_key text NOT NULL,
  thumbnail_object_key text NOT NULL,
  sha256 char(64) NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  original_filename text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_card_id, ordinal),
  UNIQUE (product_card_id, sha256),
  CHECK (original_object_key <> thumbnail_object_key),
  CHECK (position(('product-cards/' || product_card_id::text || '/images/' || id::text || '/') in original_object_key) = 1),
  CHECK (position(('product-cards/' || product_card_id::text || '/images/' || id::text || '/') in thumbnail_object_key) = 1)
);

CREATE INDEX IF NOT EXISTS product_card_images_card_ordinal_idx
  ON suite_workbench.product_card_images (product_card_id, ordinal);

CREATE TABLE IF NOT EXISTS suite_workbench.product_onboarding_sessions (
  id uuid PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  draft_card_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(draft_card_json) = 'object'),
  draft_images_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(draft_images_json) = 'array'),
  missing_required_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_required_fields_json) = 'array'),
  product_card_id uuid NULL REFERENCES suite_workbench.product_cards(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_onboarding_sessions_status_updated_idx
  ON suite_workbench.product_onboarding_sessions (status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS product_onboarding_sessions_product_card_idx
  ON suite_workbench.product_onboarding_sessions (product_card_id)
  WHERE product_card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS suite_workbench.product_onboarding_messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES suite_workbench.product_onboarding_sessions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  attachments_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments_json) = 'array'),
  template_version_id uuid NULL,
  model_snapshot_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, ordinal)
);

CREATE INDEX IF NOT EXISTS product_onboarding_messages_session_ordinal_idx
  ON suite_workbench.product_onboarding_messages (session_id, ordinal);
