create table "user_vault_knives" (
  "user_id" text not null references "user" ("id") on delete cascade,
  "id" text not null,
  "name" text not null,
  "brand" text not null default '',
  "steel" text not null default '',
  "blade_style" text not null default '',
  "handle_material" text not null default '',
  "images" text not null,
  "specs" text not null,
  "description" text not null default '',
  "added_at" text not null,
  "updated_at" text not null,
  "source_url" text not null default '',
  "pinned" integer not null default 0,
  primary key ("user_id", "id")
);

create index "user_vault_knives_user_updated_idx"
  on "user_vault_knives" ("user_id", "updated_at");

create table "compare_list" (
  "user_id" text not null references "user" ("id") on delete cascade,
  "knife_id" text not null,
  "added_at" text not null,
  primary key ("user_id", "knife_id"),
  foreign key ("user_id", "knife_id")
    references "user_vault_knives" ("user_id", "id")
    on delete cascade
);

create index "compare_list_user_added_idx"
  on "compare_list" ("user_id", "added_at");
