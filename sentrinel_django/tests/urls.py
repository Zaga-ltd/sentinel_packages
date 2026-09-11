from django.http import HttpResponse, JsonResponse
from django.urls import path


def ok(request):
    return HttpResponse("ok")


def detail(request, pk):
    return JsonResponse({"id": pk})


def boom(request):
    raise ValueError("kaboom")


def slow(request):
    return HttpResponse("slow")


urlpatterns = [
    path("ok/", ok, name="ok"),
    path("orders/<int:pk>/", detail, name="detail"),
    path("boom/", boom, name="boom"),
    path("slow/", slow, name="slow"),
]
