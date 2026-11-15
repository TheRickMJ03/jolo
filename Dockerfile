# The JOLO brain (api/ + jolo_agent/ + menu_reader/), served on port 8080.
#
#   docker compose up --build        (see docker-compose.yml and docs/docker.md)
FROM python:3.12-slim

# opencv / paddle need these shared libraries
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Heavy dependencies first, so code changes don't reinstall them.
RUN pip install --no-cache-dir torch==2.15.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
COPY requirements.txt requirements-agent.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -r requirements-agent.txt -c requirements.txt

COPY config.yaml ./
COPY menu_reader menu_reader
COPY jolo_agent jolo_agent
COPY api api
COPY scripts scripts
COPY eval/photos.csv eval/ground_truth.csv eval/
COPY data data
COPY docker/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV PYTHONUNBUFFERED=1 JOLO_PROFILE=vm
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
