"""Ranking metrics for the search evaluation."""

import math


def dcg(grades):
    """Discounted cumulative gain: a grade-3 result counts 7, grade-2 3, grade-1 1; later ranks count less."""
    return sum((2 ** grade - 1) / math.log2(rank + 2) for rank, grade in enumerate(grades))


def ndcg_at(ranked_ids, relevant, k=5):
    """1.0 = the best possible top k; 0.0 = nothing relevant in the top k.

    ranked_ids: what the search returned, best first. relevant: {id: grade}.
    """
    ideal = dcg(sorted(relevant.values(), reverse=True)[:k])
    if ideal == 0:
        return 0.0
    return dcg([relevant.get(item, 0) for item in ranked_ids[:k]]) / ideal


def recall(found_ids, relevant, min_grade=2):
    """The share of the relevant ids (grade >= min_grade) that were found."""
    wanted = {item for item, grade in relevant.items() if grade >= min_grade}
    if not wanted:
        return 1.0
    return len(wanted & set(found_ids)) / len(wanted)
