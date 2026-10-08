"""记录中删除与迟到事件的竞争验证。"""

import base64
from concurrent.futures import ThreadPoolExecutor

from capture.backend.storage import Store
from config import Settings


def flow(identifier):
    return {
        "id": identifier,
        "request": {"headers": [], "body_b64": base64.b64encode(b"test body").decode()},
    }


def test_live_delete_rejects_late_events_after_reopen(tmp_path):
    store = Store(tmp_path)
    session = store.create_session(Settings().model_dump())
    store.save_flow(session, flow("first"))
    assert store.delete_flows(session, ["first", "queued"]) == 1
    store.close()
    store = Store(tmp_path)
    store.save_flow(session, flow("first"))
    store.save_flow(session, flow("queued"))
    assert store.list_flows(session)["total"] == 0
    assert not list((tmp_path / session / "bodies").iterdir())
    store.save_flow(session, flow("next"))
    assert store.list_flows(session)["total"] == 1
    assert store.delete_flows(session) == 1
    store.save_flow(session, flow("next"))
    store.save_flow(session, flow("new"))
    assert store.list_flows(session)["items"][0]["id"] == "new"
    store.close()


def test_concurrent_delete_and_responses_do_not_restore_flow(tmp_path):
    store = Store(tmp_path)
    session = store.create_session(Settings().model_dump())
    store.save_flow(session, flow("race"))
    with ThreadPoolExecutor(max_workers=4) as pool:
        tasks = [pool.submit(store.save_flow, session, flow("race")) for _ in range(15)]
        tasks.append(pool.submit(store.delete_flows, session, ["race"]))
        for task in tasks:
            task.result()
    store.save_flow(session, flow("race"))
    assert store.list_flows(session)["total"] == 0
    assert not list((tmp_path / session / "bodies").iterdir())
    store.close()
