
import os
import mysql.connector
from dotenv import load_dotenv

load_dotenv()

try:
    connection = mysql.connector.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "NepalAgriculture")
    )

    cursor = connection.cursor()

    print("\n========== DATABASE CHECK ==========")

    tables = [
        "crops",
        "ecological_regions",
        "districts",
        "production_records",
        "climate_records"
    ]

    for table in tables:
        cursor.execute(f"SELECT COUNT(*) FROM `{table}`")
        count = cursor.fetchone()[0]
        print(f"{table}: {count} rows")

    print("\n========== PRODUCTION SAMPLE ==========")

    cursor.execute("SELECT * FROM production_records LIMIT 5")

    for row in cursor.fetchall():
        print(row)

    print("\n========== JOIN CHECK ==========")

    cursor.execute("""
        SELECT COUNT(*)
        FROM production_records pr
        JOIN crops c ON c.crop_id = pr.crop_id
        JOIN districts d ON d.district_id = pr.district_id
        JOIN ecological_regions er ON er.region_id = d.region_id
    """)

    print("Valid joined records:", cursor.fetchone()[0])

    print("\n========== YEARS AVAILABLE ==========")

    cursor.execute("""
        SELECT DISTINCT production_year
        FROM production_records
        ORDER BY production_year
    """)

    print(cursor.fetchall())

    print("\nDATABASE CHECK COMPLETED!")

    cursor.close()
    connection.close()

except Exception as error:
    print("ERROR:", error)
