CREATE TABLE "list_items" (
	"list_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "list_items_list_id_business_id_pk" PRIMARY KEY("list_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_lists__name" CHECK (length("lists"."name") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"prompt" text,
	"intent" jsonb,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" text DEFAULT 'relevance' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"notify_new" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_saved_searches__visibility" CHECK ("saved_searches"."visibility" IN ('private', 'workspace')),
	CONSTRAINT "ck_saved_searches__name" CHECK (length("saved_searches"."name") BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "category_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "short_description" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (setweight(bf_tsvector(display_name, display_name, display_name), 'A') || setweight(bf_tsvector(category_text, category_text, category_text), 'B') || setweight(to_tsvector('simple'::regconfig, f_unaccent(coalesce(locality, '') || ' ' || coalesce(formatted_address, ''))), 'C') || setweight(bf_tsvector(short_description, short_description, short_description), 'D')) STORED;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "embedding_text_hash" text;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "score" smallint;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "score_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_list_items__list_id_added_at" ON "list_items" USING btree ("list_id","added_at" DESC NULLS LAST,"business_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_list_items__business_id" ON "list_items" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lists__organization_id_name" ON "lists" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_lists__organization_id_created_at" ON "lists" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_saved_searches__organization_id_created_at" ON "saved_searches" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "org_businesses" ADD CONSTRAINT "org_businesses_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD CONSTRAINT "ck_org_businesses__score" CHECK ("org_businesses"."score" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "org_businesses" ADD CONSTRAINT "ck_org_businesses__tier" CHECK ("org_businesses"."tier" IN ('A', 'B', 'C', 'X'));--> statement-breakpoint
CREATE TRIGGER lists_set_updated_at BEFORE UPDATE ON "lists" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER saved_searches_set_updated_at BEFORE UPDATE ON "saved_searches" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- businesses.category_text (weight B of search_tsv): for each of the business's categories (primary first), the
-- labels (EN + FR) of its ancestors and its own, then its synonyms — "restaurant" finds pizzerias. Kept by
-- triggers so every write path (ingestion, manual edits, merges, taxonomy reseeds) agrees.
CREATE OR REPLACE FUNCTION bf_category_text(p_business_id uuid) RETURNS text
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce(string_agg(
      concat_ws(' ',
        (SELECT string_agg(concat_ws(' ', a.labels->>'en', a.labels->>'fr'), ' ' ORDER BY nlevel(a.path))
         FROM categories a WHERE a.path @> c.path),
        (SELECT string_agg(s, ' ')
         FROM jsonb_array_elements_text(coalesce(c.synonyms->'en', '[]'::jsonb) || coalesce(c.synonyms->'fr', '[]'::jsonb)) AS s)),
      ' ' ORDER BY bc.is_primary DESC, c.slug), '')
    FROM business_categories bc
    JOIN categories c ON c.id = bc.category_id
    WHERE bc.business_id = p_business_id
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bf_business_categories_refresh_text() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE businesses b SET category_text = bf_category_text(b.id)
  WHERE b.id IN (
      SELECT business_id FROM new_rows
      UNION SELECT business_id FROM old_rows
    )
    AND b.category_text IS DISTINCT FROM bf_category_text(b.id);
  RETURN NULL;
END
$$;--> statement-breakpoint
-- Statement-level with transition tables: one refresh per statement, however many rows it touched. A trigger with
-- transition tables serves one event, hence three.
CREATE OR REPLACE FUNCTION bf_business_categories_refresh_text_ins() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE businesses b SET category_text = bf_category_text(b.id)
  WHERE b.id IN (SELECT business_id FROM new_rows) AND b.category_text IS DISTINCT FROM bf_category_text(b.id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bf_business_categories_refresh_text_del() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE businesses b SET category_text = bf_category_text(b.id)
  WHERE b.id IN (SELECT business_id FROM old_rows) AND b.category_text IS DISTINCT FROM bf_category_text(b.id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER business_categories_text_ins AFTER INSERT ON "business_categories"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bf_business_categories_refresh_text_ins();--> statement-breakpoint
CREATE TRIGGER business_categories_text_upd AFTER UPDATE ON "business_categories"
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION bf_business_categories_refresh_text();--> statement-breakpoint
CREATE TRIGGER business_categories_text_del AFTER DELETE ON "business_categories"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION bf_business_categories_refresh_text_del();--> statement-breakpoint
-- A renamed or moved category refreshes the text of every business in it or below it.
CREATE OR REPLACE FUNCTION bf_categories_refresh_business_text() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE businesses b SET category_text = bf_category_text(b.id)
  WHERE b.id IN (
      SELECT bc.business_id FROM business_categories bc
      JOIN categories sub ON sub.id = bc.category_id
      JOIN new_rows n ON sub.path <@ n.path
      JOIN old_rows o ON o.id = n.id
      WHERE n.labels IS DISTINCT FROM o.labels OR n.synonyms IS DISTINCT FROM o.synonyms OR n.path IS DISTINCT FROM o.path
    )
    AND b.category_text IS DISTINCT FROM bf_category_text(b.id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER categories_business_text AFTER UPDATE ON "categories"
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION bf_categories_refresh_business_text();--> statement-breakpoint
UPDATE businesses b SET category_text = bf_category_text(b.id)
WHERE EXISTS (SELECT 1 FROM business_categories bc WHERE bc.business_id = b.id);
