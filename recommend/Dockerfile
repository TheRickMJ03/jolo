# The trends job, run on a schedule. Build from the repo root:
#
#   docker build -f recommend/Dockerfile -t jolo-trends .
#
# The two scrapers live outside this repo; mount them read-only:
#
#   docker run -d --restart unless-stopped --name jolo-trends \
#     -v ~/Scraper_test:/scrapers:ro \
#     -v /path/to/service-account.json:/secrets/key.json:ro \
#     -e JOLO_SERVICE_ACCOUNT=/secrets/key.json \
#     -e CAMOFOX_BASE_URL=http://host.docker.internal:9377 \
#     jolo-trends
#
# Default: blogs and Reddit, once every 24 hours. See docs/trends-and-insights.md.
FROM python:3.12-slim

WORKDIR /app
COPY recommend/requirements.txt recommend/requirements.txt
RUN pip install --no-cache-dir -r recommend/requirements.txt
COPY recommend recommend

ENV PYTHONUNBUFFERED=1 \
    BLOG_FINDER_PATH=/scrapers/blog-finder \
    SCRAPER_TEST_PATH=/scrapers \
    FIRESTORE_PROJECT_ID=jolo-ec76d

ENTRYPOINT ["python", "-m", "recommend.job", "--analytics", "--scrape"]
CMD ["--every", "24"]
