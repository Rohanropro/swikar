
"use strict";

// =========================================================
// NEPAL AGRICULTURE DASHBOARD
// Flask API + MySQL + Chart.js
// =========================================================

const API = {
    filters: "/api/filters",
    dashboard: "/api/dashboard",
    climate: "/api/climate",
    health: "/api/health"
};

const state = {
    page: 1,
    pageSize: 10,
    charts: {},
    filters: {
        crop_id: "",
        district_id: "",
        year: "",
        season: ""
    }
};

const COLORS = [
    "#246b3b",
    "#85ae78",
    "#d1a74a",
    "#7096b8",
    "#bb8665",
    "#9c8ab8",
    "#64a49a",
    "#c67e9b",
    "#8d9e60"
];

const $ = (id) => document.getElementById(id);

const numberFormat = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
});

function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? numberFormat.format(number) : "0";
}

function formatDecimal(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number)
        ? number.toLocaleString("en-US", {
            minimumFractionDigits: 0,
            maximumFractionDigits: digits
        })
        : "0";
}

function escapeHTML(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

// =========================================================
// FETCH HELPER
// =========================================================

async function fetchJSON(url) {
    const response = await fetch(url, {
        headers: {
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        let message = `Request failed (${response.status})`;

        try {
            const body = await response.json();
            if (body.error) message = body.error;
        } catch (_) {}

        throw new Error(message);
    }

    return response.json();
}

function buildQuery(extra = {}) {
    const params = new URLSearchParams();

    Object.entries(state.filters).forEach(([key, value]) => {
        if (value !== "") {
            params.set(key, value);
        }
    });

    Object.entries(extra).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            params.set(key, value);
        }
    });

    return params.toString();
}

// =========================================================
// STATUS
// =========================================================

function setConnectionStatus(connected, message = "") {
    const dot = $("statusDot");
    const text = $("connectionText");

    if (dot) {
        dot.classList.toggle("offline", !connected);
    }

    if (text) {
        text.textContent = message || (
            connected ? "Data connected" : "Connection error"
        );
    }
}

// =========================================================
// FILTERS
// =========================================================

async function loadFilters() {
    try {
        const data = await fetchJSON(API.filters);

        const cropSelect = $("cropFilter");
        const districtSelect = $("districtFilter");
        const yearSelect = $("yearFilter");

        if (cropSelect) {
            cropSelect.innerHTML = '<option value="">All Crops</option>';

            data.crops.forEach(crop => {
                cropSelect.add(new Option(
                    crop.crop_name,
                    crop.crop_id
                ));
            });
        }

        if (districtSelect) {
            districtSelect.innerHTML = '<option value="">All Districts</option>';

            data.districts.forEach(district => {
                districtSelect.add(new Option(
                    district.district_name,
                    district.district_id
                ));
            });
        }

        if (yearSelect) {
            yearSelect.innerHTML = '<option value="">All Years</option>';

            data.years.forEach(year => {
                yearSelect.add(new Option(String(year), year));
            });
        }

        setConnectionStatus(true, "Data connected");

    } catch (error) {
        console.error("Filter loading error:", error);
        setConnectionStatus(false, "Database error");
        showGlobalError(error.message);
    }
}

// =========================================================
// FILTER EVENTS
// =========================================================

function setupFilters() {
    const filterElements = {
        crop_id: $("cropFilter"),
        district_id: $("districtFilter"),
        year: $("yearFilter"),
        season: $("seasonFilter")
    };

    Object.entries(filterElements).forEach(([key, element]) => {
        if (!element) return;

        element.addEventListener("change", () => {
            state.filters[key] = element.value;
            state.page = 1;
            refreshDashboard();
        });
    });

    $("resetFilters")?.addEventListener("click", () => {
        Object.values(filterElements).forEach(element => {
            if (element) element.value = "";
        });

        Object.keys(state.filters).forEach(key => {
            state.filters[key] = "";
        });

        state.page = 1;
        refreshDashboard();
    });
}

// =========================================================
// CHART DEFAULTS
// =========================================================

Chart.defaults.font.family = "Inter, Arial, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = "#839084";

Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 8;
Chart.defaults.plugins.legend.labels.padding = 15;

const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
        duration: 500
    },
    interaction: {
        intersect: false,
        mode: "index"
    },
    plugins: {
        legend: {
            display: false
        },
        tooltip: {
            backgroundColor: "#183c23",
            titleColor: "#ffffff",
            bodyColor: "#e9f3e9",
            padding: 12,
            cornerRadius: 8
        }
    },
    scales: {
        x: {
            grid: {
                display: false
            },
            border: {
                display: false
            },
            ticks: {
                maxRotation: 0,
                autoSkip: true
            }
        },
        y: {
            beginAtZero: true,
            grid: {
                color: "#edf1ed"
            },
            border: {
                display: false,
                dash: [4, 4]
            }
        }
    }
};

// =========================================================
// CHART RENDERING
// =========================================================

function showEmpty(chartId, emptyId, isEmpty) {
    const canvas = $(chartId);
    const empty = $(emptyId);

    if (canvas) {
        canvas.style.visibility = isEmpty ? "hidden" : "visible";
    }

    if (empty) {
        empty.classList.toggle("visible", isEmpty);
    }
}

function destroyChart(name) {
    if (state.charts[name]) {
        state.charts[name].destroy();
        state.charts[name] = null;
    }
}

function renderLineChart(name, canvasId, emptyId, labels, datasets) {
    destroyChart(name);

    const hasData = datasets.some(dataset =>
        dataset.data.some(value => Number(value) !== 0 && value !== null)
    );

    showEmpty(canvasId, emptyId, !labels.length || !hasData);

    if (!labels.length || !hasData) return;

    const ctx = $(canvasId).getContext("2d");

    state.charts[name] = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets
        },
        options: {
            ...commonOptions,
            plugins: {
                ...commonOptions.plugins,
                legend: {
                    display: datasets.length > 1,
                    position: "bottom"
                }
            },
            elements: {
                line: {
                    tension: 0.35
                },
                point: {
                    radius: 3,
                    hoverRadius: 6
                }
            }
        }
    });
}

function renderBarChart(name, canvasId, emptyId, labels, values, label) {
    destroyChart(name);

    const hasData = values.some(value => Number(value) > 0);

    showEmpty(canvasId, emptyId, !labels.length || !hasData);

    if (!labels.length || !hasData) return;

    const ctx = $(canvasId).getContext("2d");

    state.charts[name] = new Chart(ctx, {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label,
                data: values,
                backgroundColor: labels.map(
                    (_, index) => COLORS[index % COLORS.length]
                ),
                borderRadius: 5,
                maxBarThickness: 35
            }]
        },
        options: {
            ...commonOptions,
            indexAxis: "y",
            plugins: {
                ...commonOptions.plugins,
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: {
                        color: "#edf1ed"
                    },
                    border: {
                        display: false
                    }
                },
                y: {
                    grid: {
                        display: false
                    },
                    border: {
                        display: false
                    }
                }
            }
        }
    });
}

function renderDoughnut(name, canvasId, emptyId, labels, values) {
    destroyChart(name);

    const hasData = values.some(value => Number(value) > 0);

    showEmpty(canvasId, emptyId, !labels.length || !hasData);

    if (!labels.length || !hasData) return;

    state.charts[name] = new Chart($(canvasId), {
        type: "doughnut",
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: labels.map(
                    (_, index) => COLORS[index % COLORS.length]
                ),
                borderColor: "#ffffff",
                borderWidth: 3,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "65%",
            plugins: {
                legend: {
                    display: true,
                    position: "bottom"
                },
                tooltip: {
                    backgroundColor: "#183c23",
                    padding: 12
                }
            }
        }
    });
}

// =========================================================
// KPI CARDS
// =========================================================

function renderKPIs(data) {
    const kpis = data.kpis;

    $("totalCrops").textContent = formatNumber(kpis.total_crops);
    $("totalDistricts").textContent = formatNumber(kpis.total_districts);

    $("totalRecords").textContent = formatNumber(
        kpis.filtered_records
    );

    $("totalClimate").textContent = formatNumber(
        kpis.climate_records
    );
}

// =========================================================
// PRODUCTION CHARTS
// =========================================================

function renderProductionCharts(data) {
    const yearly = data.yearly || [];
    const regional = data.regional || [];
    const cropMix = data.crop_mix || [];
    const yields = data.district_yield || [];

    // YEARLY TREND
    renderLineChart(
        "yearly",
        "yearlyChart",
        "yearlyEmpty",
        yearly.map(row => String(row.year)),
        [{
            label: "Production (MT)",
            data: yearly.map(row => Number(row.production) || 0),
            borderColor: "#287440",
            backgroundColor: "rgba(40,116,64,0.10)",
            fill: true,
            borderWidth: 3
        }]
    );

    // REGION COMPARISON
    renderBarChart(
        "region",
        "regionChart",
        "regionEmpty",
        regional.map(row => row.region),
        regional.map(row => Number(row.production) || 0),
        "Production (MT)"
    );

    // CROP MIX
    renderDoughnut(
        "crop",
        "cropChart",
        "cropEmpty",
        cropMix.map(row => row.crop),
        cropMix.map(row => Number(row.production) || 0)
    );

    // DISTRICT YIELD
    renderBarChart(
        "yield",
        "yieldChart",
        "yieldEmpty",
        yields.map(row => row.district),
        yields.map(row => Number(row.yield_value) || 0),
        "Yield (kg/ha)"
    );
}

// =========================================================
// CLIMATE CHARTS
// =========================================================

function renderClimateCharts(data) {
    const monthly = data.monthly || [];
    const seasonal = data.seasonal || [];

    // MONTHLY RAINFALL
    renderLineChart(
        "rain",
        "rainChart",
        "rainEmpty",
        monthly.map(row => `${row.year}-${String(row.month).padStart(2, "0")}`),
        [{
            label: "Rainfall",
            data: monthly.map(row => Number(row.rainfall) || 0),
            borderColor: "#4b91c3",
            backgroundColor: "rgba(75,145,195,0.12)",
            fill: true,
            borderWidth: 2
        }]
    );

    // MONTHLY TEMPERATURE
    renderLineChart(
        "temperature",
        "temperatureChart",
        "temperatureEmpty",
        monthly.map(row => `${row.year}-${String(row.month).padStart(2, "0")}`),
        [{
            label: "Mean Temperature (°C)",
            data: monthly.map(row => Number(row.mean_temperature) || 0),
            borderColor: "#d48a48",
            backgroundColor: "rgba(212,138,72,0.10)",
            fill: true,
            borderWidth: 2
        }]
    );

    // SEASONAL TABLE
    const table = $("seasonalTable");

    if (!seasonal.length) {
        table.innerHTML = `
            <tr>
                <td colspan="5" class="table-message">
                    No seasonal climate records available.
                </td>
            </tr>
        `;
        return;
    }

    table.innerHTML = seasonal.map(row => `
        <tr>
            <td><strong>${escapeHTML(row.season)}</strong></td>
            <td>${formatDecimal(row.mean_temperature)}</td>
            <td>${formatDecimal(row.rainfall)}</td>
            <td>${formatDecimal(row.humidity)}%</td>
            <td>${formatDecimal(row.solar_radiation)}</td>
        </tr>
    `).join("");
}

// =========================================================
// QUICK INSIGHTS
// =========================================================

function renderInsights(insights) {
    const container = $("insightsContainer");

    if (!insights || !insights.length) {
        container.innerHTML = `
            <div class="insight-card">
                <h4>Insights</h4>
                <strong>No data available</strong>
                <p>Try adjusting your filters.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = insights.map(item => `
        <article class="insight-card">
            <h4>${escapeHTML(item.title)}</h4>
            <strong>${escapeHTML(item.value)}</strong>
            <p>${escapeHTML(item.detail)}</p>
        </article>
    `).join("");
}

// =========================================================
// PRODUCTION RECORD TABLE
// =========================================================

function renderRecords(data) {
    const records = data.recent_records || [];
    const pagination = data.pagination;

    const tbody = $("recordsTable");

    $("recordCount").textContent =
        `${formatNumber(pagination.total)} records`;

    $("pageInfo").textContent =
        `Page ${pagination.page} of ${pagination.total_pages}`;

    $("prevPage").disabled = pagination.page <= 1;
    $("nextPage").disabled =
        pagination.page >= pagination.total_pages;

    if (!records.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="table-message">
                    No production records found for this selection.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = records.map(row => `
        <tr>
            <td>${escapeHTML(row.year)}</td>
            <td>${escapeHTML(row.district)}</td>
            <td>${escapeHTML(row.crop)}</td>
            <td>${formatDecimal(row.area)}</td>
            <td>${formatDecimal(row.production)}</td>
            <td>${formatDecimal(row.yield_value)}</td>
        </tr>
    `).join("");
}

// =========================================================
// GLOBAL ERROR
// =========================================================

function showGlobalError(message) {
    console.error(message);

    const container = $("insightsContainer");

    if (container) {
        container.innerHTML = `
            <div class="insight-card">
                <h4>Dashboard error</h4>
                <strong>Unable to load data</strong>
                <p>${escapeHTML(message)}</p>
            </div>
        `;
    }
}

// =========================================================
// LOAD DASHBOARD
// =========================================================

async function loadDashboard() {
    const query = buildQuery({
        page: state.page,
        page_size: state.pageSize
    });

    try {
        const data = await fetchJSON(`${API.dashboard}?${query}`);

        renderKPIs(data);
        renderProductionCharts(data);
        renderRecords(data);
        renderInsights(data.insights);

        setConnectionStatus(true, "Data connected");

    } catch (error) {
        console.error("Dashboard loading error:", error);
        setConnectionStatus(false, "Database error");
        showGlobalError(error.message);
    }
}

// =========================================================
// LOAD CLIMATE
// =========================================================

async function loadClimate() {
    const query = buildQuery();

    try {
        const data = await fetchJSON(`${API.climate}?${query}`);

        renderClimateCharts(data);

    } catch (error) {
        console.error("Climate loading error:", error);

        showEmpty("rainChart", "rainEmpty", true);
        showEmpty("temperatureChart", "temperatureEmpty", true);

        $("seasonalTable").innerHTML = `
            <tr>
                <td colspan="5" class="table-message">
                    Unable to load climate data. Check climate_records.
                </td>
            </tr>
        `;
    }
}

// =========================================================
// REFRESH BOTH DASHBOARD AND CLIMATE
// =========================================================

async function refreshDashboard() {
    await Promise.all([
        loadDashboard(),
        loadClimate()
    ]);
}

// =========================================================
// PAGINATION
// =========================================================

function setupPagination() {
    $("prevPage").addEventListener("click", () => {
        if (state.page > 1) {
            state.page--;
            loadDashboard();
        }
    });

    $("nextPage").addEventListener("click", () => {
        state.page++;
        loadDashboard();
    });
}

// =========================================================
// SIDEBAR NAVIGATION
// =========================================================

function setupNavigation() {
    const navItems = document.querySelectorAll(".nav-item");

    navItems.forEach(item => {
        item.addEventListener("click", event => {
            event.preventDefault();

            navItems.forEach(nav => nav.classList.remove("active"));
            item.classList.add("active");

            const page = item.dataset.page;
            const title = item.textContent.trim();

            $("pageTitle").textContent = title;

            if (page === "dashboard") {
                $("mainHeading").textContent =
                    "Nepal Crop Production Dashboard";
            } else {
                $("mainHeading").textContent = title;

                if (page === "regional") {
                    $("regionChart").scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                    });
                } else if (page === "environment") {
                    $("rainChart").scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                    });
                } else if (page === "yield") {
                    $("yieldChart").scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                    });
                } else if (page === "data") {
                    $("recordsTable").scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                    });
                } else if (page === "insights") {
                    $("insightsContainer").scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                    });
                } else if (page === "about") {
                    alert(
                        "Nepal Crop Production Trend Analysis and Yield Prediction System\n\n" +
                        "Frontend: HTML, CSS, JavaScript\n" +
                        "Backend: Python Flask\n" +
                        "Database: MySQL\n" +
                        "Visualization: Chart.js\n\n" +
                        "All dashboard statistics are retrieved from MySQL."
                    );
                }
            }

            if (window.innerWidth <= 900) {
                $("sidebar").classList.remove("open");
            }
        });
    });

    $("mobileMenu").addEventListener("click", () => {
        $("sidebar").classList.toggle("open");
    });
}

// =========================================================
// INITIALIZATION
// =========================================================

async function initializeDashboard() {
    setupFilters();
    setupPagination();
    setupNavigation();

    await loadFilters();
    await refreshDashboard();
}

document.addEventListener("DOMContentLoaded", initializeDashboard);
