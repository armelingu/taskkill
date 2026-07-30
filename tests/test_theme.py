"""
Sincronização de tema entre dispositivos: preferência persistida em
users.theme_pref, exposta no /api/profile e injetada no HTML (anti-FOUC).
"""


def _put_theme(client, mode):
    return client.put('/api/profile/theme', json={'mode': mode},
                      headers={'X-CSRF-Token': client.csrf})


def test_default_theme_is_system(auth_client):
    body = auth_client.get('/api/profile').get_json()
    assert body['theme_pref'] == 'system'


def test_update_theme_persists_and_reflects_in_profile(auth_client):
    resp = _put_theme(auth_client, 'dark')
    assert resp.status_code == 200
    assert resp.get_json()['theme_pref'] == 'dark'

    body = auth_client.get('/api/profile').get_json()
    assert body['theme_pref'] == 'dark'


def test_update_theme_rejects_invalid(auth_client):
    for bad in ('rainbow', '', 'DARK', 'sepia'):
        resp = _put_theme(auth_client, bad)
        assert resp.status_code == 400


def test_index_injects_saved_theme_mode(auth_client):
    _put_theme(auth_client, 'light')
    html = auth_client.get('/').get_data(as_text=True)
    assert 'data-theme-mode="light"' in html


def test_theme_requires_csrf(auth_client):
    # Sem header X-CSRF-Token -> 403 (mutação protegida).
    resp = auth_client.put('/api/profile/theme', json={'mode': 'dark'})
    assert resp.status_code == 403
