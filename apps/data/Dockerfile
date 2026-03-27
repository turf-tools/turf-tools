FROM ghcr.io/astral-sh/uv:0.7-python3.13-trixie-slim

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1

WORKDIR /app

# Install dependencies first (cached layer)
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project

# Copy application code and install project
COPY . .
RUN uv sync --locked --no-install-project

ENV PATH="/app/.venv/bin:$PATH"

CMD ["python", "main.py"]
