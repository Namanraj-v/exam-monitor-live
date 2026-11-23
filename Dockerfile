FROM python:3.11-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd -m -u 1000 exam
COPY --chown=exam:exam . .
RUN chown exam:exam /srv
USER exam
EXPOSE 7860
CMD ["python","server.py"]
