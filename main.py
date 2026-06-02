"""LeafVault FastAPI 应用装配入口。"""

from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from starlette.responses import FileResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from core.config import ALLOWED_ORIGINS, CSRF_HEADER_NAME, ENVIRONMENT, SECURITY_HEADERS_ENABLED, STATIC_DIR, TEMPLATES_DIR, TRUSTED_HOSTS, UPLOAD_DIR, logger
from core.csrf import csrf_protection_middleware
from core.rate_limit import limiter
from core.security_headers import apply_security_headers
from db.init_db import init_db
from routers.ai import router as ai_router
from routers.auth import router as auth_router
from routers.diary import router as diary_router
from routers.ledger import router as ledger_router
from routers.stats import router as stats_router
from routers.sync import router as sync_router
from routers.user import router as user_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("✅ 数据库初始化完成")
    yield
    logger.info("🛑 应用正在关闭")


app = FastAPI(
    title="LeafVault API",
    description="个人记录中枢后端接口 — 安全修复版",
    lifespan=lifespan,
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    if SECURITY_HEADERS_ENABLED:
        apply_security_headers(response)
    return response


@app.middleware("http")
async def enforce_cookie_csrf(request: Request, call_next):
    return await csrf_protection_middleware(request, call_next)


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type", CSRF_HEADER_NAME],
)

if ENVIRONMENT == "production":
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=TRUSTED_HOSTS)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

@app.get("/service-worker.js", include_in_schema=False)
async def service_worker():
    """
    将 static/service-worker.js 暴露到根路径 /service-worker.js，
    让 PWA Service Worker 的 scope 可以覆盖整个站点 /。
    """
    return FileResponse(
        Path(STATIC_DIR) / "service-worker.js",
        media_type="application/javascript",
        headers={
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )

@app.get("/static/images/{image_name:path}")
async def legacy_static_image(image_name: str):
    """兼容旧数据库中的 /static/images/* 路径。

    新上传文件统一写入 UPLOAD_DIR 并通过 /uploads/* 访问；历史路径先查
    static/images，找不到时再查 UPLOAD_DIR 中的同名文件。
    """
    filename = Path(image_name).name
    if not filename or filename != image_name or ".." in image_name:
        raise HTTPException(status_code=404, detail="Image not found")
    legacy_path = STATIC_DIR / "images" / filename
    upload_path = UPLOAD_DIR / filename
    if legacy_path.exists() and legacy_path.is_file():
        return FileResponse(legacy_path)
    if upload_path.exists() and upload_path.is_file():
        return FileResponse(upload_path)
    raise HTTPException(status_code=404, detail="Image not found")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


@app.get("/")
async def root(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


app.include_router(auth_router)
app.include_router(user_router)
app.include_router(diary_router)
app.include_router(ledger_router)
app.include_router(stats_router)
app.include_router(sync_router)
app.include_router(ai_router)

