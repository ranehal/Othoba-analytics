# 🛒 Othoba Price Tracker & Analytics Suite

> **Multi-Threaded API Harvester, HAR Reverse-Engineering Engine & Price Analytics Dashboard for Othoba.com.**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-0099ff?style=for-the-badge&logo=github)](https://ranehal.github.io/othobaTRACKER/)
[![Python 3.9+](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![JavaScript ES6+](https://img.shields.io/badge/JavaScript-ES6%2B-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

---

## 📌 Executive Summary

**othobaTRACKER** is an automated catalog ingestion engine and historical price tracking web dashboard engineered for [Othoba.com](https://www.othoba.com), PRAN-RFL Group's online shopping marketplace in Bangladesh.

The platform reverse-engineers Othoba's backend REST API (`app.othoba.com/api-frontend`), executes concurrent multi-threaded requests (`ThreadPoolExecutor`), handles `gzip` compressed network responses, and generates static dataset exports consumed by a zero-dependency web dashboard hosted on GitHub Pages.

---

## 🚀 Key Features

- **🔐 Reverse-Engineered HAR Forensic Engine**: Discovered authentication headers (`authorization: 11CZ+eanknvgRupFlOA0Eg`) and API endpoints from mobile HAR network inspection.
- **⚡ Multi-Threaded Ingestion (`scraper.py`)**: Uses Python's `ThreadPoolExecutor` for parallel category pagination across catalog endpoints.
- **📦 Gzip Response Processing**: Handles raw `gzip` HTTP payloads transparently using Python standard library headers.
- **🌐 Static GitHub Pages Hosting**: Exports structured static JSON datasets directly into `frontend/`, allowing serverless deployment on GitHub Pages.
- **⚡ Windows Launcher Script (`runall.bat`)**: Single-click script for automated scraping, local web server execution, and GitHub git push workflows (`push.bat`).

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Reverse_Engineering ["🔐 HAR Analysis Phase"]
        HAR[Reqable HAR Capture] -->|extract_har.py| Credentials[Extract API Token & Headers]
    end

    subgraph Scraper_Pipeline ["⚡ Ingestion Engine"]
        Credentials --> Scraper[scraper.py ThreadPoolExecutor]
        Scraper -->|POST JSON-Patch API| API[app.othoba.com/api-frontend]
        API-->>|Gzip Compressed JSON| Scraper
    end

    subgraph Storage_And_UI ["📊 Presentation & Deployment"]
        Scraper -->|Export Datasets| FrontendData[frontend/*.json]
        FrontendData --> SPA[frontend/index.html SPA Dashboard]
        SPA -->|push.bat| GHPages[GitHub Pages Deployment]
    end
```

---

## 📁 Repository Structure

```
othoba/
├── scraper.py           # Multi-threaded API scraper (urllib, ThreadPoolExecutor)
├── extract_har.py       # HAR file network traffic extractor & analyzer
├── runall.bat           # Interactive Windows batch launcher (Scraper / Server / Both)
├── push.bat             # Git automation script for committing and pushing updates
├── frontend/            # Web Application SPA & Data Export Directory
│   ├── index.html       # Single-page dashboard interface
│   ├── app.js           # Analytics logic, catalog filter, and chart rendering
│   └── styles.css       # Responsive dark-mode styling
└── README.md            # Technical documentation
```

---

## 🛠️ API & Header Specification

- **Base Endpoint**: `https://app.othoba.com/api-frontend`
- **Authorization Token**: `11CZ+eanknvgRupFlOA0Eg`
- **Content Type**: `application/json-patch+json`
- **User-Agent Header**: `okhttp/4.9.3`

---

## ⚡ Quick Start & Usage

### 1. Interactive Windows Launcher
Run [`runall.bat`](file:///C:/PROJECTS/othoba/runall.bat):
```cmd
runall.bat
```
Select option 1 to scrape, option 2 to run the dashboard server, or option 3 to execute both.

### 2. Command Line Execution
```bash
# Execute scraper engine
python scraper.py

# Launch local dashboard server
python -m http.server 8000 -d frontend
```
Open `http://localhost:8000` in your web browser.

---

## 📜 License

Distributed under the MIT License. Trademarks and data belong to Othoba.com / PRAN-RFL Group. Built for analytical tracking.
