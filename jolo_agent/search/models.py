"""The two small retrieval models, in the agent's process: on the CPU by default, on a GPU when
config agent.search.device says so ("cuda", or "auto" for a GPU when there is one).

    Qwen3-Embedding-0.6B   text -> vector, for the "means the same" half of search
    Qwen3-Reranker-0.6B    (query, café) -> how well the café answers the query

They load on first use. Downloads go to config agent.search.models_dir (on the
E: drive), not to the Hugging Face default on C:.
"""

import logging
import os

from menu_reader.config import REPO

log = logging.getLogger("jolo.search")

RERANK_INSTRUCTION = "Given a customer's request for a café, judge whether this café and its menu items satisfy the request"
# The prompt format from the Qwen3-Reranker model card: the model answers "yes" or "no".
RERANK_PREFIX = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and '
                 'the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
RERANK_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


def pick_device(settings):
    """"cpu" (default), "cuda", or "auto". Returns the device name and the dtype to load the weights in."""
    import torch
    wanted = settings.get("device", "cpu")
    if wanted == "auto":
        wanted = "cuda" if torch.cuda.is_available() else "cpu"
    if wanted == "cuda" and not torch.cuda.is_available():
        log.warning("agent.search.device is cuda but no GPU is visible; using the CPU")
        wanted = "cpu"
    return wanted, (torch.float16 if wanted == "cuda" else torch.float32)


def _cache_dir(settings):
    """Where model files are downloaded. Passed to every loader explicitly:
    HF_HOME alone is ignored once huggingface_hub has been imported."""
    path = REPO / settings["models_dir"]
    (path / "hub").mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(path))
    return str(path / "hub")


class Embedder:
    def __init__(self, settings):
        self.settings = settings
        self._model = None

    def _load(self):
        if self._model is None:
            cache = _cache_dir(self.settings)
            import torch
            from sentence_transformers import SentenceTransformer
            device, dtype = pick_device(self.settings)
            self._model = SentenceTransformer(self.settings["embedding_model"], device=device,
                                              cache_folder=cache, model_kwargs={"dtype": dtype})
        return self._model

    def embed_documents(self, texts):
        """list of texts -> list of unit-length vectors (lists of floats)."""
        vectors = self._load().encode(list(texts), normalize_embeddings=True, batch_size=16)
        return vectors.tolist()

    def embed_query(self, text):
        return self._load().encode([text], prompt_name="query", normalize_embeddings=True)[0].tolist()


class Reranker:
    def __init__(self, settings):
        self.settings = settings
        self._loaded = None

    def _load(self):
        if self._loaded is None:
            cache = _cache_dir(self.settings)
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
            name = self.settings["reranker_model"]
            tokenizer = AutoTokenizer.from_pretrained(name, padding_side="left", cache_dir=cache)
            device, dtype = pick_device(self.settings)
            model = AutoModelForCausalLM.from_pretrained(name, dtype=dtype, cache_dir=cache).eval().to(device)
            self._loaded = (tokenizer, model, tokenizer.convert_tokens_to_ids("yes"),
                            tokenizer.convert_tokens_to_ids("no"), device)
        return self._loaded

    def score(self, query, documents, max_length=256):
        """How well each document answers the query: a list of numbers from 0 to 1."""
        import torch
        tokenizer, model, yes_id, no_id, device = self._load()
        texts = [f"{RERANK_PREFIX}<Instruct>: {RERANK_INSTRUCTION}\n<Query>: {query}\n<Document>: {document[:1500]}{RERANK_SUFFIX}"
                 for document in documents]
        scores = []
        for start in range(0, len(texts), 8):
            batch = tokenizer(texts[start:start + 8], padding=True, truncation=True,
                              max_length=max_length, return_tensors="pt").to(device)
            with torch.no_grad():
                logits = model(**batch).logits[:, -1, :]
            pair = torch.stack([logits[:, no_id], logits[:, yes_id]], dim=1)
            scores.extend(torch.softmax(pair, dim=1)[:, 1].tolist())
        return scores


def load_models(config):
    """(embedder or None, reranker or None, notes). A model that is switched off
    or can't be imported is None, and search carries on without it."""
    settings = config["agent"]["search"]
    embedder = reranker = None
    notes = []
    _cache_dir(settings)
    try:
        import sentence_transformers  # noqa: F401
        import torch                  # noqa: F401
    except ImportError as error:
        notes.append(f"keyword search only: {error}. Install requirements-agent.txt for embeddings and the reranker.")
        return None, None, notes
    if settings["use_embeddings"]:
        embedder = Embedder(settings)
    else:
        notes.append("embeddings switched off (agent.search.use_embeddings)")
    if settings["use_reranker"]:
        reranker = Reranker(settings)
    else:
        notes.append("reranker switched off (agent.search.use_reranker)")
    return embedder, reranker, notes
