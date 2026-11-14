-- Sample queries (run on both MySQL 8 and SQLite 3.25+)
-- Each query is separated by a blank line and a "-- Q<n>:" title.

-- Q1: The 10 largest spills ever recorded
SELECT name, incident_date, country, volume_barrels
FROM v_incident_details
WHERE volume_barrels IS NOT NULL
ORDER BY volume_barrels DESC
LIMIT 10;

-- Q2: Incidents and total volume per country (GROUP BY + aggregate)
SELECT country, incidents, total_barrels, total_fatalities
FROM v_country_summary
WHERE incidents > 0
ORDER BY total_barrels DESC;

-- Q3: Countries with more than one incident (HAVING)
SELECT c.name AS country, COUNT(*) AS incidents
FROM incident i
JOIN country c ON c.country_id = i.country_id
GROUP BY c.country_id, c.name
HAVING COUNT(*) > 1
ORDER BY incidents DESC;

-- Q4: Which causes lead to the biggest spills
SELECT cause, incidents, total_barrels
FROM v_cause_summary
ORDER BY total_barrels DESC;

-- Q5: Trend by decade
SELECT decade, incidents, total_barrels
FROM v_incidents_by_decade
ORDER BY decade;

-- Q6: Companies involved in more than one incident (multi-table join)
SELECT co.name AS company, COUNT(DISTINCT ic.incident_id) AS incidents
FROM company co
JOIN incident_company ic ON ic.company_id = co.company_id
GROUP BY co.company_id, co.name
HAVING COUNT(DISTINCT ic.incident_id) > 1;

-- Q7: Spills larger than the average spill (subquery)
SELECT name, volume_barrels
FROM incident
WHERE volume_barrels > (SELECT AVG(volume_barrels) FROM incident)
ORDER BY volume_barrels DESC;

-- Q8: Rank spills inside each environment (window function)
SELECT environment, name, volume_barrels,
       RANK() OVER (PARTITION BY environment ORDER BY volume_barrels DESC) AS rank_in_environment
FROM incident
WHERE volume_barrels IS NOT NULL;

-- Q9: Deadliest incidents and their causes
SELECT name, incident_date, fatalities, cause
FROM v_incident_details
WHERE fatalities > 0
ORDER BY fatalities DESC;

-- Q10: Incidents with unknown volume (NULL handling)
SELECT name, country, volume_confidence
FROM v_incident_details
WHERE volume_barrels IS NULL;

-- Q11: Impact types most commonly caused (many-to-many join)
SELECT it.name AS impact, COUNT(*) AS incidents
FROM incident_impact ii
JOIN impact_type it ON it.impact_type_id = ii.impact_type_id
GROUP BY it.impact_type_id, it.name
ORDER BY incidents DESC;

-- Q12: Common table expression: share of total volume per region
WITH region_totals AS (
  SELECT region, SUM(volume_barrels) AS barrels
  FROM v_incident_details
  GROUP BY region
)
SELECT region, barrels,
       ROUND(100.0 * barrels / (SELECT SUM(barrels) FROM region_totals), 1) AS percent_of_total
FROM region_totals
ORDER BY barrels DESC;

-- Q13: Incidents still ongoing
SELECT name, incident_date, country, status
FROM v_incident_details
WHERE status = 'ongoing';

-- Q14: Spills that happened in freshwater or on land with a pipeline source
SELECT name, incident_date, country, environment, volume_barrels
FROM v_incident_details
WHERE source_type = 'pipeline' AND environment IN ('land','freshwater')
ORDER BY volume_barrels DESC;
