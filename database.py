import os

from werkzeug.security import generate_password_hash

# A fundação de acesso ao banco (caminho, conexão, pragmas) vive em storage/db.py
# e o esquema/migrações em storage/schema.py. Re-exportamos aqui para manter
# compatibilidade com quem importa de `database`.
from storage.db import get_db_path, get_db_connection  # noqa: F401
from storage.schema import init_db  # noqa: F401


# ---------------------------------------------------------------------------
# Hashing de senha (centralizado)
# ---------------------------------------------------------------------------
# Preferimos scrypt (mais resistente a ataque de hardware que o pbkdf2) e caímos
# para pbkdf2:sha256 se o ambiente não suportar scrypt (ex.: OpenSSL sem suporte).
# Centralizar aqui permite rehash-on-login: ao logar, se o hash usar um método
# antigo, ele é regravado com o método atual de forma transparente.
def _resolve_pwhash_method() -> str:
    method = os.environ.get('TASKKILL_PWHASH_METHOD', 'scrypt')
    try:
        generate_password_hash('probe', method=method)
        return method
    except Exception:
        return 'pbkdf2:sha256'


PWHASH_METHOD = _resolve_pwhash_method()


def hash_password(password: str) -> str:
    """Gera o hash da senha usando o método atual (scrypt por padrão)."""
    return generate_password_hash(password, method=PWHASH_METHOD)


def password_needs_rehash(hashed: str) -> bool:
    """
    True se o hash armazenado não usa o método atual (ex.: pbkdf2 antigo quando
    o padrão agora é scrypt). Usado para migrar o hash no próximo login válido.
    """
    prefix = PWHASH_METHOD.split(':', 1)[0] + ':'
    return not (hashed or '').startswith(prefix)
