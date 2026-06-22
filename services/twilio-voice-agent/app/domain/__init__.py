"""SureShot Books domain brain (v4.6)."""
from .sureshot_brain import build_domain_excerpt, domain_answer_for_intent
from .faq import match_faq, FAQ_ANSWERS
from .policies import politics_redirect_message, sports_redirect_message
