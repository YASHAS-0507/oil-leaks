-- Oil Leaks Database: SQLite schema (used by the live website and local build)
-- The MySQL version with stored procedures lives in db/mysql/schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE country (
  country_id INTEGER PRIMARY KEY AUTOINCREMENT,
  iso_code   TEXT NOT NULL UNIQUE CHECK (length(iso_code) = 2),
  name       TEXT NOT NULL UNIQUE,
  region     TEXT NOT NULL
);

CREATE TABLE company (
  company_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  company_type TEXT NOT NULL CHECK (company_type IN
    ('oil_major','state_owned','independent','refiner','pipeline_operator',
     'shipping','contractor','rail','mining','government')),
  country_id   INTEGER REFERENCES country(country_id) ON DELETE SET NULL
);

CREATE TABLE cause (
  cause_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE
);

CREATE TABLE impact_type (
  impact_type_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE
);

CREATE TABLE incident (
  incident_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  incident_date     TEXT NOT NULL CHECK (incident_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  country_id        INTEGER NOT NULL REFERENCES country(country_id),
  location_name     TEXT NOT NULL,
  latitude          REAL NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
  longitude         REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  environment       TEXT NOT NULL CHECK (environment IN ('land','freshwater','marine','mixed')),
  source_type       TEXT NOT NULL CHECK (source_type IN
    ('tanker','cargo_ship','pipeline','offshore_platform','onshore_well',
     'storage_facility','rail','deliberate','unknown')),
  cause_id          INTEGER NOT NULL REFERENCES cause(cause_id),
  volume_barrels    INTEGER CHECK (volume_barrels IS NULL OR volume_barrels >= 0),
  volume_confidence TEXT NOT NULL DEFAULT 'low' CHECK (volume_confidence IN ('low','medium','high')),
  fatalities        INTEGER NOT NULL DEFAULT 0 CHECK (fatalities >= 0),
  status            TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ongoing','contained','closed','unknown')),
  summary           TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE incident_company (
  incident_id INTEGER NOT NULL REFERENCES incident(incident_id) ON DELETE CASCADE,
  company_id  INTEGER NOT NULL REFERENCES company(company_id)   ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('operator','owner','contractor','charterer')),
  PRIMARY KEY (incident_id, company_id, role)
);

CREATE TABLE incident_impact (
  incident_id    INTEGER NOT NULL REFERENCES incident(incident_id)       ON DELETE CASCADE,
  impact_type_id INTEGER NOT NULL REFERENCES impact_type(impact_type_id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, impact_type_id)
);

CREATE TABLE source_reference (
  reference_id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id  INTEGER REFERENCES incident(incident_id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  publisher    TEXT
);

CREATE TABLE incident_audit (
  audit_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  action      TEXT NOT NULL,
  old_name    TEXT,
  old_volume  INTEGER,
  changed_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_incident_date    ON incident(incident_date);
CREATE INDEX idx_incident_country ON incident(country_id);
CREATE INDEX idx_incident_cause   ON incident(cause_id);
CREATE INDEX idx_incident_env_src ON incident(environment, source_type);
CREATE INDEX idx_company_country  ON company(country_id);
CREATE INDEX idx_reference_incident ON source_reference(incident_id);

-- Triggers --------------------------------------------------------------

-- Reject incidents dated in the future
CREATE TRIGGER trg_incident_no_future_date
BEFORE INSERT ON incident
WHEN NEW.incident_date > date('now')
BEGIN
  SELECT RAISE(ABORT, 'incident_date cannot be in the future');
END;

-- Keep an audit trail of updates and deletes
CREATE TRIGGER trg_incident_audit_update
AFTER UPDATE ON incident
BEGIN
  INSERT INTO incident_audit (incident_id, action, old_name, old_volume)
  VALUES (OLD.incident_id, 'UPDATE', OLD.name, OLD.volume_barrels);
END;

CREATE TRIGGER trg_incident_audit_delete
AFTER DELETE ON incident
BEGIN
  INSERT INTO incident_audit (incident_id, action, old_name, old_volume)
  VALUES (OLD.incident_id, 'DELETE', OLD.name, OLD.volume_barrels);
END;

-- Views -----------------------------------------------------------------

CREATE VIEW v_incident_details AS
SELECT i.incident_id, i.name, i.incident_date,
       CAST(substr(i.incident_date, 1, 4) AS INTEGER) AS year,
       c.name AS country, c.region, i.location_name, i.latitude, i.longitude,
       i.environment, i.source_type, ca.name AS cause,
       i.volume_barrels, ROUND(i.volume_barrels * 0.1364) AS volume_tonnes_approx,
       i.volume_confidence, i.fatalities, i.status, i.summary
FROM incident i
JOIN country c  ON c.country_id = i.country_id
JOIN cause   ca ON ca.cause_id  = i.cause_id;

CREATE VIEW v_country_summary AS
SELECT c.name AS country, c.region,
       COUNT(i.incident_id)            AS incidents,
       COALESCE(SUM(i.volume_barrels), 0) AS total_barrels,
       COALESCE(SUM(i.fatalities), 0)  AS total_fatalities
FROM country c
LEFT JOIN incident i ON i.country_id = c.country_id
GROUP BY c.country_id;

CREATE VIEW v_incidents_by_decade AS
SELECT (CAST(substr(incident_date, 1, 4) AS INTEGER) / 10) * 10 AS decade,
       COUNT(*) AS incidents,
       COALESCE(SUM(volume_barrels), 0) AS total_barrels
FROM incident
GROUP BY decade;

CREATE VIEW v_cause_summary AS
SELECT ca.name AS cause, COUNT(i.incident_id) AS incidents,
       COALESCE(SUM(i.volume_barrels), 0) AS total_barrels
FROM cause ca
LEFT JOIN incident i ON i.cause_id = ca.cause_id
GROUP BY ca.cause_id;
