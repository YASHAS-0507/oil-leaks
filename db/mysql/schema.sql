-- Oil Leaks Database: MySQL 8.0+ schema
-- Run:  mysql -u root -p < db/mysql/schema.sql
--       mysql -u root -p oil_leaks < db/mysql/seed.sql
--       mysql -u root -p oil_leaks < db/mysql/queries.sql

CREATE DATABASE IF NOT EXISTS oil_leaks CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE oil_leaks;

SET FOREIGN_KEY_CHECKS = 0;
DROP VIEW  IF EXISTS v_vessel_details, v_fleet_status, v_cause_summary, v_incidents_by_decade, v_country_summary, v_incident_details;
DROP TABLE IF EXISTS vessel_event, vessel, route_waypoint, shipping_route, incident_audit, source_reference, incident_impact, incident_company,
                     incident, impact_type, cause, company, country;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE country (
  country_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  iso_code   CHAR(2)      NOT NULL,
  name       VARCHAR(100) NOT NULL,
  region     VARCHAR(50)  NOT NULL,
  PRIMARY KEY (country_id),
  UNIQUE KEY uq_country_iso (iso_code),
  UNIQUE KEY uq_country_name (name)
) ENGINE=InnoDB;

CREATE TABLE company (
  company_id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(150) NOT NULL,
  company_type ENUM('oil_major','state_owned','independent','refiner','pipeline_operator',
                    'shipping','contractor','rail','mining','government') NOT NULL,
  country_id   INT UNSIGNED NULL,
  PRIMARY KEY (company_id),
  UNIQUE KEY uq_company_name (name),
  KEY idx_company_country (country_id),
  CONSTRAINT fk_company_country FOREIGN KEY (country_id)
    REFERENCES country (country_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE cause (
  cause_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name     VARCHAR(60)  NOT NULL,
  PRIMARY KEY (cause_id),
  UNIQUE KEY uq_cause_name (name)
) ENGINE=InnoDB;

CREATE TABLE impact_type (
  impact_type_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(60)  NOT NULL,
  PRIMARY KEY (impact_type_id),
  UNIQUE KEY uq_impact_name (name)
) ENGINE=InnoDB;

CREATE TABLE incident (
  incident_id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(200) NOT NULL,
  incident_date     DATE         NOT NULL,
  country_id        INT UNSIGNED NOT NULL,
  location_name     VARCHAR(200) NOT NULL,
  latitude          DECIMAL(8,5) NOT NULL,
  longitude         DECIMAL(8,5) NOT NULL,
  environment       ENUM('land','freshwater','marine','mixed') NOT NULL,
  source_type       ENUM('tanker','cargo_ship','pipeline','offshore_platform','onshore_well',
                         'storage_facility','rail','deliberate','unknown') NOT NULL,
  cause_id          INT UNSIGNED NOT NULL,
  volume_barrels    INT UNSIGNED NULL,
  volume_confidence ENUM('low','medium','high') NOT NULL DEFAULT 'low',
  fatalities        INT UNSIGNED NOT NULL DEFAULT 0,
  status            ENUM('ongoing','contained','closed','unknown') NOT NULL DEFAULT 'unknown',
  summary           TEXT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (incident_id),
  KEY idx_incident_date (incident_date),
  KEY idx_incident_country (country_id),
  KEY idx_incident_cause (cause_id),
  KEY idx_incident_env_src (environment, source_type),
  CONSTRAINT fk_incident_country FOREIGN KEY (country_id) REFERENCES country (country_id),
  CONSTRAINT fk_incident_cause   FOREIGN KEY (cause_id)   REFERENCES cause (cause_id),
  CONSTRAINT chk_incident_lat CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT chk_incident_lon CHECK (longitude BETWEEN -180 AND 180)
) ENGINE=InnoDB;

CREATE TABLE incident_company (
  incident_id INT UNSIGNED NOT NULL,
  company_id  INT UNSIGNED NOT NULL,
  role        ENUM('operator','owner','contractor','charterer') NOT NULL,
  PRIMARY KEY (incident_id, company_id, role),
  KEY idx_ic_company (company_id),
  CONSTRAINT fk_ic_incident FOREIGN KEY (incident_id) REFERENCES incident (incident_id) ON DELETE CASCADE,
  CONSTRAINT fk_ic_company  FOREIGN KEY (company_id)  REFERENCES company (company_id)   ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE incident_impact (
  incident_id    INT UNSIGNED NOT NULL,
  impact_type_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (incident_id, impact_type_id),
  KEY idx_ii_impact (impact_type_id),
  CONSTRAINT fk_ii_incident FOREIGN KEY (incident_id)    REFERENCES incident (incident_id)       ON DELETE CASCADE,
  CONSTRAINT fk_ii_impact   FOREIGN KEY (impact_type_id) REFERENCES impact_type (impact_type_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE source_reference (
  reference_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_id  INT UNSIGNED NULL,
  title        VARCHAR(255) NOT NULL,
  url          VARCHAR(500) NOT NULL,
  publisher    VARCHAR(100) NULL,
  PRIMARY KEY (reference_id),
  KEY idx_reference_incident (incident_id),
  CONSTRAINT fk_ref_incident FOREIGN KEY (incident_id) REFERENCES incident (incident_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE incident_audit (
  audit_id    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_id INT UNSIGNED NOT NULL,
  action      VARCHAR(10)  NOT NULL,
  old_name    VARCHAR(200) NULL,
  old_volume  INT UNSIGNED NULL,
  changed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (audit_id)
) ENGINE=InnoDB;

-- Views -----------------------------------------------------------------

CREATE VIEW v_incident_details AS
SELECT i.incident_id, i.name, i.incident_date,
       YEAR(i.incident_date) AS year,
       c.name AS country, c.region, i.location_name, i.latitude, i.longitude,
       i.environment, i.source_type, ca.name AS cause,
       i.volume_barrels, ROUND(i.volume_barrels * 0.1364) AS volume_tonnes_approx,
       i.volume_confidence, i.fatalities, i.status, i.summary
FROM incident i
JOIN country c  ON c.country_id = i.country_id
JOIN cause   ca ON ca.cause_id  = i.cause_id;

CREATE VIEW v_country_summary AS
SELECT c.name AS country, c.region,
       COUNT(i.incident_id)               AS incidents,
       COALESCE(SUM(i.volume_barrels), 0) AS total_barrels,
       COALESCE(SUM(i.fatalities), 0)     AS total_fatalities
FROM country c
LEFT JOIN incident i ON i.country_id = c.country_id
GROUP BY c.country_id, c.name, c.region;

CREATE VIEW v_incidents_by_decade AS
SELECT (YEAR(incident_date) DIV 10) * 10 AS decade,
       COUNT(*) AS incidents,
       COALESCE(SUM(volume_barrels), 0) AS total_barrels
FROM incident
GROUP BY decade;

CREATE VIEW v_cause_summary AS
SELECT ca.name AS cause, COUNT(i.incident_id) AS incidents,
       COALESCE(SUM(i.volume_barrels), 0) AS total_barrels
FROM cause ca
LEFT JOIN incident i ON i.cause_id = ca.cause_id
GROUP BY ca.cause_id, ca.name;

-- Triggers, function and stored procedure ---------------------------------

DELIMITER $$

CREATE TRIGGER trg_incident_no_future_date
BEFORE INSERT ON incident
FOR EACH ROW
BEGIN
  IF NEW.incident_date > CURDATE() THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident_date cannot be in the future';
  END IF;
END$$

CREATE TRIGGER trg_incident_audit_update
AFTER UPDATE ON incident
FOR EACH ROW
BEGIN
  INSERT INTO incident_audit (incident_id, action, old_name, old_volume)
  VALUES (OLD.incident_id, 'UPDATE', OLD.name, OLD.volume_barrels);
END$$

CREATE TRIGGER trg_incident_audit_delete
AFTER DELETE ON incident
FOR EACH ROW
BEGIN
  INSERT INTO incident_audit (incident_id, action, old_name, old_volume)
  VALUES (OLD.incident_id, 'DELETE', OLD.name, OLD.volume_barrels);
END$$

-- Approximate conversion: about 7.33 barrels of crude per metric tonne
CREATE FUNCTION fn_barrels_to_tonnes(p_barrels INT UNSIGNED)
RETURNS DECIMAL(14,1) DETERMINISTIC
BEGIN
  RETURN ROUND(p_barrels / 7.33, 1);
END$$

-- Largest spills for one country, e.g. CALL sp_top_spills_by_country('US', 5);
CREATE PROCEDURE sp_top_spills_by_country(IN p_iso CHAR(2), IN p_limit INT)
BEGIN
  SELECT i.name, i.incident_date, i.volume_barrels, i.fatalities
  FROM incident i
  JOIN country c ON c.country_id = i.country_id
  WHERE c.iso_code = p_iso AND i.volume_barrels IS NOT NULL
  ORDER BY i.volume_barrels DESC
  LIMIT p_limit;
END$$

DELIMITER ;

-- Fleet simulation (powers the globe) -------------------------------------
-- All vessels are fictional. Positions are cached from the simulation.

CREATE TABLE shipping_route (
  route_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name     VARCHAR(120) NOT NULL,
  PRIMARY KEY (route_id),
  UNIQUE KEY uq_route_name (name)
) ENGINE=InnoDB;

CREATE TABLE route_waypoint (
  route_id  INT UNSIGNED NOT NULL,
  seq       INT UNSIGNED NOT NULL,
  latitude  DECIMAL(8,5) NOT NULL,
  longitude DECIMAL(8,5) NOT NULL,
  PRIMARY KEY (route_id, seq),
  CONSTRAINT fk_wp_route FOREIGN KEY (route_id) REFERENCES shipping_route (route_id) ON DELETE CASCADE,
  CONSTRAINT chk_wp_lat CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT chk_wp_lon CHECK (longitude BETWEEN -180 AND 180)
) ENGINE=InnoDB;

CREATE TABLE vessel (
  vessel_id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(100) NOT NULL,
  vessel_type    ENUM('crude_tanker','product_tanker','container_ship','bulk_carrier') NOT NULL,
  route_id       INT UNSIGNED NOT NULL,
  direction      TINYINT NOT NULL DEFAULT 1,
  speed_knots    DECIMAL(4,1) NOT NULL,
  progress       DECIMAL(7,6) NOT NULL DEFAULT 0,
  latitude       DECIMAL(8,5) NULL,
  longitude      DECIMAL(8,5) NULL,
  status         ENUM('running','stalled','leaking') NOT NULL DEFAULT 'running',
  status_reason  VARCHAR(120) NULL,
  leaked_barrels INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (vessel_id),
  UNIQUE KEY uq_vessel_name (name),
  KEY idx_vessel_route (route_id),
  KEY idx_vessel_status (status),
  CONSTRAINT fk_vessel_route FOREIGN KEY (route_id) REFERENCES shipping_route (route_id),
  CONSTRAINT chk_vessel_dir CHECK (direction IN (-1, 1)),
  CONSTRAINT chk_vessel_speed CHECK (speed_knots > 0),
  CONSTRAINT chk_vessel_progress CHECK (progress BETWEEN 0 AND 1)
) ENGINE=InnoDB;

CREATE TABLE vessel_event (
  event_id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  vessel_id  INT UNSIGNED NOT NULL,
  event_type ENUM('running','stalled','leaking') NOT NULL,
  latitude   DECIMAL(8,5) NULL,
  longitude  DECIMAL(8,5) NULL,
  note       VARCHAR(120) NULL,
  event_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id),
  KEY idx_vessel_event_vessel (vessel_id),
  CONSTRAINT fk_event_vessel FOREIGN KEY (vessel_id) REFERENCES vessel (vessel_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE VIEW v_fleet_status AS
SELECT status, COUNT(*) AS vessels, COALESCE(SUM(leaked_barrels), 0) AS leaked_barrels
FROM vessel
GROUP BY status;

CREATE VIEW v_vessel_details AS
SELECT v.vessel_id, v.name, v.vessel_type, r.name AS route, v.speed_knots, v.status, v.status_reason,
       v.latitude, v.longitude, v.leaked_barrels
FROM vessel v
JOIN shipping_route r ON r.route_id = v.route_id;

DELIMITER $$

-- Every status change is logged automatically
CREATE TRIGGER trg_vessel_status_log
AFTER UPDATE ON vessel
FOR EACH ROW
BEGIN
  IF NEW.status <> OLD.status THEN
    INSERT INTO vessel_event (vessel_id, event_type, latitude, longitude, note)
    VALUES (NEW.vessel_id, NEW.status, NEW.latitude, NEW.longitude, NEW.status_reason);
  END IF;
END$$

DELIMITER ;
