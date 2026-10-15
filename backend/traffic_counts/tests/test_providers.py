"""Offline provider contract tests; every transport/auth call is mocked."""
from datetime import datetime, timedelta, timezone
import json
import os
import sys
import unittest
import types
from unittest.mock import patch, MagicMock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from traffic_counts import providers as p
from traffic_counts.catalog import SOURCES, BACKEND_BRANDS

START = datetime(2026, 10, 13, 0, 0, tzinfo=timezone.utc)
END = START + timedelta(minutes=2)
GRAFANA_ENV = {"TRAFFIC_GRAFANA_URL": "https://ecom-grafana.test-magrabi.com", "TRAFFIC_GRAFANA_TOKEN": "test-only-token"}


def metric(series, name="RequestCount"):
    return {"interval": "PT1M", "timespan": p._iso(START)+"/"+p._iso(END), "value": [{"name": {"value": name}, "errorCode": "Success", "timeseries": [
        {"metadatavalues": [{"name": {"value": k}, "value": v} for k,v in dims.items()],
         "data": [{"timeStamp": p._iso(START + timedelta(minutes=i)), "total": n} for i,n in enumerate(values)]}
        for dims,values in series]}]}


def vector(rows):
    return {"status": "success", "data": {"resultType": "vector", "result": [
        {"metric": labels, "value": [END.timestamp() - 0.001, str(n)]} for labels,n in rows]}}


class ProviderTests(unittest.TestCase):
    def azure(self, responses, source="frontdoor_main"):
        with patch.object(p, "_azure_token", return_value="fake"), patch.object(p, "_get_json", side_effect=responses) as get:
            result = p.collect(source, START, END)
            return result, get.call_args_list

    def loki(self, response, source="ecom_ingress"):
        with patch.dict(os.environ, GRAFANA_ENV, clear=True), patch.object(p, "_get_json", return_value=response) as get:
            result = p.collect(source, START, END)
            return result, get.call_args_list

    def test_catalog_all_sources(self):
        self.assertEqual(set(SOURCES), {"frontdoor_main", "ecom_cdn", "ecom_ingress", "macula_gateway", "filtered_storefront"})
        self.assertEqual(SOURCES["macula_gateway"]["granularity"], "status_group")
        self.assertEqual(len(BACKEND_BRANDS), 11)

    def test_configuration_is_lazy_and_allowlisted(self):
        with patch.dict(os.environ, GRAFANA_ENV, clear=True), patch.object(p, "_sdk_available", return_value=False), patch.object(p, "_get_json") as get:
            self.assertTrue(p.configured_sources()["ecom_ingress"])
            self.assertFalse(p.configured_sources()["frontdoor_main"])
            get.assert_not_called()
        for url in ["http://ecom-grafana.test-magrabi.com", "https://evil.example", "https://user@ecom-grafana.test-magrabi.com", "https://ecom-grafana.test-magrabi.com/x", "https://ecom-grafana.test-magrabi.com?x=1"]:
            with patch.dict(os.environ, GRAFANA_ENV | {"TRAFFIC_GRAFANA_URL": url}, clear=True):
                with self.assertRaises(p.ProviderError):
                    p._grafana_settings()

    def test_azure_configuration_requires_plausible_server_identity(self):
        cases = [({}, False), ({"AZURE_MONITOR_CLIENT_ID":"id"}, False),
                 ({"AZURE_MONITOR_CLIENT_ID":"id","AZURE_MONITOR_TENANT_ID":"tenant","AZURE_MONITOR_CLIENT_SECRET":"fake"},True),
                 ({"AZURE_TENANT_ID":"tenant","AZURE_CLIENT_ID":"id","AZURE_FEDERATED_TOKEN_FILE":"/server/token"},True),
                 ({"AZURE_TENANT_ID":"tenant","AZURE_CLIENT_ID":"id","AZURE_CLIENT_SECRET":"fake"},True)]
        for env,expected in cases:
            with patch.dict(os.environ,env,clear=True),patch.object(p,"_sdk_available",return_value=True),patch.object(p,"_azure_token") as token:
                self.assertEqual(p.configured_sources()["frontdoor_main"],expected)
                token.assert_not_called()

    def test_azure_credential_reused_lazily_for_chunk_queries(self):
        azure=types.ModuleType("azure");azure.__path__=[]
        identity=types.ModuleType("azure.identity")
        identity.ClientSecretCredential=MagicMock()
        identity.DefaultAzureCredential=MagicMock()
        credential=identity.ClientSecretCredential.return_value
        credential.get_token.return_value=types.SimpleNamespace(token="unit-test-token")
        env={"AZURE_MONITOR_TENANT_ID":"tenant","AZURE_MONITOR_CLIENT_ID":"client","AZURE_MONITOR_CLIENT_SECRET":"unit-test-secret"}
        with patch.dict(sys.modules,{"azure":azure,"azure.identity":identity}),patch.dict(os.environ,env,clear=True),patch.object(p,"_AZURE_CREDENTIAL",None),patch.object(p,"_AZURE_CREDENTIAL_KEY",None):
            self.assertEqual(p._azure_token(),"unit-test-token")
            self.assertEqual(p._azure_token(),"unit-test-token")
            self.assertEqual(identity.ClientSecretCredential.call_count,1)
            identity.DefaultAzureCredential.assert_not_called()

    def test_unconfigured_never_returns_zero(self):
        with patch.dict(os.environ, {}, clear=True):
            result = p.collect("ecom_ingress", START, END)
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["rows"][0]["total"])
        self.assertIsNone(result["rows"][0]["counts"]["500"])

    def test_window_validation_before_transport(self):
        with patch.object(p, "_get_json") as get:
            for a,b in [(START.replace(tzinfo=None),END), (END,START), (START,START+timedelta(hours=2)), (START,END+timedelta(microseconds=1))]:
                self.assertEqual(p.collect("ecom_ingress", a,b)["error"], "invalid_window")
            self.assertEqual(p.collect("frontdoor_main", START+timedelta(seconds=1),END)["error"], "minute_aligned_window_required")
            get.assert_not_called()

    def test_azure_exact_status_endpoint_reconcile_and_query(self):
        control = metric([({}, [5,7])])
        statuses = metric([({"HttpStatus":"200"}, [4,5]), ({"HttpStatus":"500"},[1,2])])
        endpoints = metric([({"HttpStatus":"200","Endpoint":"a.azurefd.net"},[4,5]),({"HttpStatus":"500","Endpoint":"a.azurefd.net"},[1,2])])
        result,calls=self.azure([control,statuses,endpoints])
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["rows"][0]["total"], 12)
        self.assertEqual(result["rows"][0]["counts"]["200"], 9)
        self.assertEqual(result["rows"][0]["counts"]["501"], 0)
        self.assertEqual(result["rows"][1]["scope"], "Endpoint: a.azurefd.net")
        self.assertEqual(result["coverage"], {"expected":2,"observed":2})
        self.assertEqual(calls[0].args[1]["interval"], "PT1M")
        self.assertEqual(calls[0].args[1]["top"], "10000")
        self.assertEqual(calls[1].args[1]["$filter"], "HttpStatus eq '*'")

    def test_azure_missing_and_null_bins_are_partial(self):
        for body in [metric([({},[1])]), metric([({},[1,None])])]:
            result,_=self.azure([body])
            self.assertEqual(result["status"], "partial")
            self.assertIsNone(result["rows"][0]["total"])
            self.assertEqual(result["coverage"]["observed"],1)

    def test_azure_no_data_is_unavailable(self):
        result,_=self.azure([metric([])])
        self.assertEqual(result["status"],"unavailable")
        self.assertIsNone(result["rows"][0]["total"])

    def test_azure_zero_control_is_distinct_from_missing(self):
        result,_=self.azure([metric([({},[0,0])]),metric([]),metric([])])
        self.assertEqual(result["status"],"complete")
        self.assertEqual(result["rows"][0]["total"],0)

    def test_azure_code_mismatch_does_not_fabricate_other(self):
        result,_=self.azure([metric([({},[2,2])]),metric([({"HttpStatus":"200"},[1,1])])])
        self.assertEqual(result["error"],"metric_reconciliation_failed")
        self.assertEqual(result["status"],"partial")
        self.assertIsNone(result["rows"][0]["total"])

    def test_azure_endpoint_mismatch_is_partial(self):
        result,_=self.azure([metric([({},[2,2])]),metric([({"HttpStatus":"200"},[2,2])]),metric([({"HttpStatus":"200","Endpoint":"a"},[1,1])])])
        self.assertEqual(result["error"],"metric_reconciliation_failed")

    def test_azure_rejects_truncation_and_wrong_interval(self):
        for key,value,error in [("nextLink","https://ignored","response_truncated"),("interval","PT1H","metric_interval_mismatch"),
                               ("timespan",p._iso(START)+"/"+p._iso(END+timedelta(minutes=1)),"metric_timespan_mismatch"),
                               ("timespan",None,"metric_timespan_mismatch")]:
            data=metric([({},[1,1])]);data[key]=value
            result,_=self.azure([data])
            self.assertEqual(result["error"],error)

    def test_macula_groups_preserve_remainder_and_never_alias_200(self):
        result,calls=self.azure([metric([({},[10,10])],"ResponseStatus"),metric([({"HttpStatusGroup":"2xx"},[3,3]),({"HttpStatusGroup":"5xx"},[1,1]),({"HttpStatusGroup":"3xx"},[5,5])],"ResponseStatus")],"macula_gateway")
        row=result["rows"][0]
        self.assertEqual(result["status"],"complete")
        self.assertEqual(row["total"],20)
        self.assertEqual(row["unclassified"],2)
        self.assertEqual(row["counts"]["2xx"],6)
        self.assertNotIn("200",row["counts"])
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[1].args[1]["$filter"],"HttpStatusGroup eq '*'")

    def test_loki_parses_final_code_and_uses_instant_exclusive_time(self):
        result,calls=self.loki(vector([({"backend":"saleor-graphql-cache-80","http_code":"200"},9),({"backend":"saleor-graphql-cache-80","http_code":"499"},2)]))
        self.assertEqual(result["status"],"complete")
        self.assertEqual(result["rows"][0]["total"],11)
        self.assertEqual(result["rows"][0]["counts"]["499"],2)
        params=calls[0].args[1]
        self.assertEqual(params["time"],str(int(END.timestamp())*10**9-1))
        self.assertIn("[120s]",params["query"])
        self.assertIn("(?P<http_code>",params["query"])
        self.assertNotIn("start",params)
        self.assertNotIn("upstream_status",params["query"])

    def test_loki_empty_warned_and_bad_time_are_unavailable(self):
        for body in [vector([]),vector([])|{"warnings":["partial"]}, {"status":"error","error":"secret must not escape"}]:
            result,_=self.loki(body)
            self.assertEqual(result["status"],"unavailable")
            self.assertIsNone(result["rows"][0]["total"])
            self.assertNotIn("secret",json.dumps(result))
        body=vector([({"http_code":"200"},1)]);body["data"]["result"][0]["value"][0]=START.timestamp()
        result,_=self.loki(body)
        self.assertEqual(result["error"],"query_time_mismatch")

    def test_filtered_classes_reconcile_retained_and_excluded(self):
        result,calls=self.loki(vector([
            ({"http_code":"200","backend":"ecom-storefront-9900","traffic_class":"retained_browser_like"},10),
            ({"http_code":"500","backend":"ecom-storefront-9900","traffic_class":"retained_unknown"},2),
            ({"http_code":"200","backend":"ecom-storefront-9900","traffic_class":"monitoring_telemetry"},20),
            ({"http_code":"200","backend":"ecom-retail-rivoli-storefront-9900","traffic_class":"declared_bot_or_crawler"},5),
        ]),"filtered_storefront")
        self.assertEqual(result["status"],"complete")
        self.assertEqual(result["rows"][0]["total"],12)
        self.assertEqual(result["rows"][0]["trafficClass"],"retained")
        class_rows=[r for r in result["rows"] if r["scope"].startswith("Class: ")]
        self.assertEqual(sum(r["total"] for r in class_rows),37)
        self.assertEqual(sum(r["total"] for r in class_rows if r["trafficClass"].startswith("retained_")),12)
        query=calls[0].args[1]["query"]
        for term in ["edge health probe","azure-health-probe","saleor/","next.js middleware","retained_unknown","/monitoring"]:
            self.assertIn(term,query)
        self.assertLess(query.index("edge health probe"),query.index("saleor/"))
        self.assertNotIn("beta-storefront",query)

    def test_filtered_invalid_backend_or_class_not_emitted(self):
        for backend,cls in [("unknown-service","retained_unknown"),("ecom-storefront-9900","pretend-human")]:
            result,_=self.loki(vector([({"http_code":"200","backend":backend,"traffic_class":cls},1)]),"filtered_storefront")
            self.assertEqual(result["status"],"unavailable")
            self.assertEqual(result["error"],"invalid_upstream_response")

    def test_unsafe_labels_and_non_integer_counts_rejected(self):
        for labels,n in [({"backend":"token?private=secret","http_code":"200"},1),({"http_code":"200"},1.2),({"http_code":"200"},"NaN"),({"http_code":"200"},-1),({"http_code":"999"},1)]:
            result,_=self.loki(vector([(labels,n)]))
            self.assertEqual(result["status"],"unavailable")
            self.assertNotIn("private",json.dumps(result))

    def test_transport_tls_redirects_size_and_safe_errors(self):
        response=MagicMock();response.status_code=200;response.iter_content.return_value=[b'{"ok":true}'];response.__enter__.return_value=response
        with patch.object(p.requests,"get",return_value=response) as get:
            self.assertEqual(p._get_json("https://management.azure.com/test",{}),{"ok":True})
            self.assertTrue(get.call_args.kwargs["verify"])
            self.assertFalse(get.call_args.kwargs["allow_redirects"])
            self.assertEqual(get.call_args.kwargs["timeout"],(5,25))
        response.iter_content.return_value=[b"x"*(p.MAX_BYTES+1)]
        with patch.object(p.requests,"get",return_value=response),self.assertRaisesRegex(p.ProviderError,"response_too_large"):
            p._get_json("https://management.azure.com/test",{})
        response.status_code=302
        with patch.object(p.requests,"get",return_value=response),self.assertRaisesRegex(p.ProviderError,"upstream_unavailable"):
            p._get_json("https://management.azure.com/test",{})

    def test_transport_retries_only_transient_status(self):
        first=MagicMock();first.status_code=429;first.__enter__.return_value=first
        second=MagicMock();second.status_code=200;second.iter_content.return_value=[b'{}'];second.__enter__.return_value=second
        with patch.object(p.requests,"get",side_effect=[first,second]) as get,patch.object(p.time,"sleep"):
            self.assertEqual(p._get_json("https://management.azure.com/test",{}),{})
            self.assertEqual(get.call_count,2)
        first.status_code=403
        with patch.object(p.requests,"get",return_value=first) as get,self.assertRaisesRegex(p.ProviderError,"access_denied"):
            p._get_json("https://management.azure.com/test",{})
        self.assertEqual(get.call_count,1)


if __name__ == "__main__":
    unittest.main()
