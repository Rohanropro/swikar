
import os
from decimal import Decimal
from datetime import date, datetime

import mysql.connector
from dotenv import load_dotenv
from flask import Flask, render_template, jsonify, request

load_dotenv()

app = Flask(__name__)


# =========================================================
# DATABASE CONNECTION
# =========================================================

def get_db_connection():
    return mysql.connector.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "NepalAgriculture"),
        connection_timeout=10
    )


def clean_value(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def fetch_all(cursor):
    return [
        {key: clean_value(value) for key, value in row.items()}
        for row in cursor.fetchall()
    ]


def json_error(message, status=500):
    return jsonify({"error": message}), status


# =========================================================
# SEASON MAPPING
# ClimateRecord is monthly.
# ProductionRecord is annual.
# Never join monthly climate directly to annual production.
# =========================================================

SEASON_MONTHS = {
    "Winter": [12, 1, 2],
    "Spring": [3, 4, 5],
    "Summer": [6, 7, 8],
    "Autumn": [9, 10, 11]
}


def get_filters():
    return {
        "crop_id": request.args.get("crop_id", "").strip(),
        "district_id": request.args.get("district_id", "").strip(),
        "year": request.args.get("year", "").strip(),
        "season": request.args.get("season", "").strip()
    }


def production_conditions(filters):
    conditions = []
    params = []

    if filters["crop_id"].isdigit():
        conditions.append("pr.crop_id = %s")
        params.append(int(filters["crop_id"]))

    if filters["district_id"].isdigit():
        conditions.append("pr.district_id = %s")
        params.append(int(filters["district_id"]))

    if filters["year"].isdigit():
        conditions.append("pr.production_year = %s")
        params.append(int(filters["year"]))

    # Season is intentionally not applied to annual production.
    # Seasonal analysis belongs to monthly climate records.

    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    return where, params


def climate_conditions(filters):
    conditions = []
    params = []

    if filters["district_id"].isdigit():
        conditions.append("cr.district_id = %s")
        params.append(int(filters["district_id"]))

    if filters["year"].isdigit():
        conditions.append("cr.year_bs = %s")
        params.append(int(filters["year"]))

    season = filters["season"]

    if season in SEASON_MONTHS:
        months = SEASON_MONTHS[season]
        placeholders = ", ".join(["%s"] * len(months))
        conditions.append(f"cr.month IN ({placeholders})")
        params.extend(months)

    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    return where, params


# =========================================================
# HOME
# =========================================================

@app.route("/")
def home():
    return render_template("index.html")


# =========================================================
# API: FILTER OPTIONS
# =========================================================

@app.route("/api/filters")
def api_filters():
    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        cursor.execute("""
            SELECT crop_id, crop_name
            FROM crops
            ORDER BY crop_name
        """)
        crops = fetch_all(cursor)

        cursor.execute("""
            SELECT district_id, district_name, region_id
            FROM districts
            ORDER BY district_name
        """)
        districts = fetch_all(cursor)

        cursor.execute("""
            SELECT region_id, region_name
            FROM ecological_regions
            ORDER BY region_name
        """)
        regions = fetch_all(cursor)

        cursor.execute("""
            SELECT DISTINCT production_year AS year
            FROM production_records
            WHERE production_year IS NOT NULL
            ORDER BY year DESC
        """)
        years = [row["year"] for row in fetch_all(cursor)]

        return jsonify({
            "crops": crops,
            "districts": districts,
            "regions": regions,
            "years": years,
            "seasons": list(SEASON_MONTHS.keys())
        })

    except mysql.connector.Error as error:
        app.logger.exception("Filter API database error")
        return json_error("Could not load filter options. Check MySQL.")

    finally:
        if cursor:
            cursor.close()
        if connection and connection.is_connected():
            connection.close()


# =========================================================
# API: MAIN DASHBOARD
# =========================================================

@app.route("/api/dashboard")
def api_dashboard():
    filters = get_filters()
    where, params = production_conditions(filters)

    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        joins = """
            FROM production_records pr
            INNER JOIN crops c
                ON c.crop_id = pr.crop_id
            INNER JOIN districts d
                ON d.district_id = pr.district_id
            INNER JOIN ecological_regions er
                ON er.region_id = d.region_id
        """

        # -----------------------------------------------------
        # KPI CARDS
        # Table counts are real database values.
        # Production count/total/area use selected filters.
        # -----------------------------------------------------

        cursor.execute("""
            SELECT
                (SELECT COUNT(*) FROM crops) AS total_crops,
                (SELECT COUNT(*) FROM districts) AS total_districts,
                (SELECT COUNT(*) FROM production_records) AS all_production_records,
                (SELECT COUNT(*) FROM climate_records) AS climate_records
        """)

        global_kpis = fetch_all(cursor)[0]

        cursor.execute(f"""
            SELECT
                COUNT(*) AS filtered_records,
                COALESCE(SUM(pr.production_tonnes), 0) AS total_production,
                COALESCE(SUM(pr.cultivated_area_hectares), 0) AS total_area,
                CASE
                    WHEN SUM(pr.cultivated_area_hectares) > 0
                    THEN SUM(pr.production_tonnes) * 1000
                         / SUM(pr.cultivated_area_hectares)
                    ELSE 0
                END AS weighted_yield
            {joins}
            {where}
        """, params)

        production_kpis = fetch_all(cursor)[0]

        # -----------------------------------------------------
        # YEARLY PRODUCTION TREND
        # -----------------------------------------------------

        cursor.execute(f"""
            SELECT
                pr.production_year AS year,
                SUM(pr.production_tonnes) AS production,
                SUM(pr.cultivated_area_hectares) AS area,
                CASE
                    WHEN SUM(pr.cultivated_area_hectares) > 0
                    THEN SUM(pr.production_tonnes) * 1000
                         / SUM(pr.cultivated_area_hectares)
                    ELSE 0
                END AS yield_value
            {joins}
            {where}
            GROUP BY pr.production_year
            ORDER BY pr.production_year
        """, params)

        yearly = fetch_all(cursor)

        # -----------------------------------------------------
        # PRODUCTION BY ECOLOGICAL REGION
        # -----------------------------------------------------

        cursor.execute(f"""
            SELECT
                er.region_name AS region,
                SUM(pr.production_tonnes) AS production,
                SUM(pr.cultivated_area_hectares) AS area
            {joins}
            {where}
            GROUP BY er.region_id, er.region_name
            ORDER BY production DESC
        """, params)

        regional = fetch_all(cursor)

        # -----------------------------------------------------
        # CROP PRODUCTION DISTRIBUTION
        # -----------------------------------------------------

        cursor.execute(f"""
            SELECT
                c.crop_name AS crop,
                SUM(pr.production_tonnes) AS production
            {joins}
            {where}
            GROUP BY c.crop_id, c.crop_name
            ORDER BY production DESC
        """, params)

        crop_mix = fetch_all(cursor)

        # -----------------------------------------------------
        # DISTRICT YIELD
        # Weighted yield = total production / total area.
        # -----------------------------------------------------

        cursor.execute(f"""
            SELECT
                d.district_name AS district,
                SUM(pr.production_tonnes) AS production,
                SUM(pr.cultivated_area_hectares) AS area,
                CASE
                    WHEN SUM(pr.cultivated_area_hectares) > 0
                    THEN SUM(pr.production_tonnes) * 1000
                         / SUM(pr.cultivated_area_hectares)
                    ELSE 0
                END AS yield_value
            {joins}
            {where}
            GROUP BY d.district_id, d.district_name
            HAVING SUM(pr.cultivated_area_hectares) > 0
            ORDER BY yield_value DESC
            LIMIT 15
        """, params)

        district_yield = fetch_all(cursor)

        # -----------------------------------------------------
        # RECENT PRODUCTION RECORDS
        # -----------------------------------------------------

        page = max(int(request.args.get("page", 1)), 1)
        page_size = min(max(int(request.args.get("page_size", 10)), 1), 100)
        offset = (page - 1) * page_size

        cursor.execute(f"""
            SELECT COUNT(*) AS total
            {joins}
            {where}
        """, params)

        total_rows = fetch_all(cursor)[0]["total"]

        cursor.execute(f"""
            SELECT
                pr.production_year AS year,
                d.district_name AS district,
                c.crop_name AS crop,
                pr.cultivated_area_hectares AS area,
                pr.production_tonnes AS production,
                CASE
                    WHEN pr.cultivated_area_hectares > 0
                    THEN pr.production_tonnes * 1000
                         / pr.cultivated_area_hectares
                    ELSE 0
                END AS yield_value
            {joins}
            {where}
            ORDER BY pr.production_year DESC, pr.production_tonnes DESC
            LIMIT %s OFFSET %s
        """, params + [page_size, offset])

        recent_records = fetch_all(cursor)

        # -----------------------------------------------------
        # DYNAMIC INSIGHTS
        # -----------------------------------------------------

        insights = []

        if crop_mix:
            insights.append({
                "title": "Leading crop",
                "value": crop_mix[0]["crop"],
                "detail": f'{crop_mix[0]["production"]:,.2f} MT total production'
            })

        if regional:
            insights.append({
                "title": "Leading ecological region",
                "value": regional[0]["region"],
                "detail": f'{regional[0]["production"]:,.2f} MT total production'
            })

        if district_yield:
            insights.append({
                "title": "Highest-yielding district",
                "value": district_yield[0]["district"],
                "detail": f'{district_yield[0]["yield_value"]:,.2f} kg/ha weighted yield'
            })

        if yearly:
            best_year = max(yearly, key=lambda row: row["production"])
            insights.append({
                "title": "Highest-production year",
                "value": str(best_year["year"]),
                "detail": f'{best_year["production"]:,.2f} MT total production'
            })

        return jsonify({
            "kpis": {
                **global_kpis,
                **production_kpis
            },
            "yearly": yearly,
            "regional": regional,
            "crop_mix": crop_mix,
            "district_yield": district_yield,
            "recent_records": recent_records,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total_rows,
                "total_pages": max((total_rows + page_size - 1) // page_size, 1)
            },
            "insights": insights
        })

    except (mysql.connector.Error, ValueError) as error:
        app.logger.exception("Dashboard API error")
        return json_error("Could not load dashboard data. Check database and filters.")

    finally:
        if cursor:
            cursor.close()
        if connection and connection.is_connected():
            connection.close()


# =========================================================
# API: ENVIRONMENTAL ANALYSIS
# =========================================================

@app.route("/api/climate")
def api_climate():
    filters = get_filters()
    where, params = climate_conditions(filters)

    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        # Monthly climate data. This query never joins annual production.
        cursor.execute(f"""
            SELECT
                cr.year_bs AS year,
                cr.month AS month,
                AVG(cr.mean_temp) AS mean_temperature,
                AVG(cr.max_temp) AS max_temperature,
                AVG(cr.min_temp) AS min_temperature,
                SUM(cr.total_rainfall) AS rainfall,
                AVG(cr.mean_humidity) AS humidity,
                SUM(cr.total_solar_rad) AS solar_radiation
            FROM climate_records cr
            {where}
            GROUP BY cr.year_bs, cr.month
            ORDER BY cr.year_bs, cr.month
        """, params)

        monthly = fetch_all(cursor)

        # Seasonal climate summary.
        cursor.execute(f"""
            SELECT
                CASE
                    WHEN cr.month IN (12, 1, 2) THEN 'Winter'
                    WHEN cr.month IN (3, 4, 5) THEN 'Spring'
                    WHEN cr.month IN (6, 7, 8) THEN 'Summer'
                    WHEN cr.month IN (9, 10, 11) THEN 'Autumn'
                END AS season,
                AVG(cr.mean_temp) AS mean_temperature,
                SUM(cr.total_rainfall) AS rainfall,
                AVG(cr.mean_humidity) AS humidity,
                SUM(cr.total_solar_rad) AS solar_radiation
            FROM climate_records cr
            {where}
            GROUP BY season
            ORDER BY FIELD(season, 'Winter', 'Spring', 'Summer', 'Autumn')
        """, params)

        seasonal = fetch_all(cursor)

        return jsonify({
            "monthly": monthly,
            "seasonal": seasonal
        })

    except mysql.connector.Error as error:
        app.logger.exception("Climate API database error")
        return json_error("Could not load climate data. Check climate_records schema.")

    finally:
        if cursor:
            cursor.close()
        if connection and connection.is_connected():
            connection.close()


# =========================================================
# HEALTH CHECK
# =========================================================

@app.route("/api/health")
def health():
    connection = None

    try:
        connection = get_db_connection()
        return jsonify({"status": "ok", "database": "connected"})

    except mysql.connector.Error:
        return jsonify({"status": "error", "database": "disconnected"}), 503

    finally:
        if connection and connection.is_connected():
            connection.close()


# =========================================================
# RUN APPLICATION
# =========================================================

if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)
