(function($) {

  $.fn.menumaker = function(options) {
      
      var cssmenu = $(this), settings = $.extend({
        title: "Menu",
        format: "dropdown",
        sticky: false
      }, options);

      return this.each(function() {
        cssmenu.prepend('<div id="menu-button">' + settings.title + '</div>');
        $(this).find("#menu-button").on('click', function(){
          $(this).toggleClass('menu-opened');
          var mainmenu = $(this).next('ul');
          if (mainmenu.hasClass('open')) { 
            mainmenu.hide().removeClass('open');
          }
          else {
            mainmenu.show().addClass('open');
            if (settings.format === "dropdown") {
              mainmenu.find('ul').show();
            }
          }
        });

        cssmenu.find('li ul').parent().addClass('has-sub');

        multiTg = function() {
          cssmenu.find(".has-sub").prepend('<span class="submenu-button"></span>');
          cssmenu.find('.submenu-button').on('click', function() {
            $(this).toggleClass('submenu-opened');
            if ($(this).siblings('ul').hasClass('open')) {
              $(this).siblings('ul').removeClass('open').hide();
            }
            else {
              $(this).siblings('ul').addClass('open').show();
            }
          });
        };

        if (settings.format === 'multitoggle') multiTg();
        else cssmenu.addClass('dropdown');

        if (settings.sticky === true) cssmenu.css('position', 'fixed');

        resizeFix = function() {
          if ($( window ).width() > 768) {
            cssmenu.find('ul').show();
          }

          if ($(window).width() <= 768) {
            cssmenu.find('ul').hide().removeClass('open');
          }
        };
        resizeFix();
        return $(window).on('resize', resizeFix);

      });
  };
})(jQuery);

(function($){
$(document).ready(function(){

$(document).ready(function() {
  $("#cssmenu").menumaker({
    title: "Menu",
    format: "multitoggle"
  });

  $("#cssmenu").prepend("<div id='menu-line'></div>");

var foundActive = false, activeElement, linePosition = 0, menuLine = $("#cssmenu #menu-line"), lineWidth, defaultPosition, defaultWidth;

$("#cssmenu > ul > li").each(function() {
  if ($(this).hasClass('active')) {
    activeElement = $(this);
    foundActive = true;
  }
});

if (foundActive === false) {
  activeElement = $("#cssmenu > ul > li").first();
}

defaultWidth = lineWidth = activeElement.width();

defaultPosition = linePosition = activeElement.position().left;

menuLine.css("width", lineWidth);
menuLine.css("left", linePosition);

$("#cssmenu > ul > li").hover(function() {
  activeElement = $(this);
  lineWidth = activeElement.width();
  linePosition = activeElement.position().left;
  menuLine.css("width", lineWidth);
  menuLine.css("left", linePosition);
}, 
function() {
  menuLine.css("left", defaultPosition);
  menuLine.css("width", defaultWidth);
});

});


});
})(jQuery);
function copiarPix() {
  // Busca o campo input pelo ID
  const campoPix = document.getElementById('pix-code-input');
  
  // Seleciona o texto
  campoPix.select();
  campoPix.setSelectionRange(0, 99999); // Para dispositivos móveis

  // Copia para a área de transferência usando a API moderna do navegador
  navigator.clipboard.writeText(campoPix.value).then(() => {
    // Feedback visual para o usuário
    const btn = document.getElementById('btn-copiar');
    const textoOriginal = btn.innerText;
    
    btn.innerText = 'Copiado!';
    btn.style.background = '#16a34a';
    btn.style.color = '#ffffff';

    // Volta ao texto original após 2 segundos
    setTimeout(() => {
      btn.innerText = textoOriginal;
      btn.style.background = '#ffffff';
      btn.style.color = 'var(--navy)';
    }, 2000);
  }).catch(err => {
    console.error('Erro ao copiar: ', err);
  });
}
function copiarPix() {
  // Busca o campo input pelo ID
  const campoPix = document.getElementById('pix-code-input');
  
  // Seleciona o texto
  campoPix.select();
  campoPix.setSelectionRange(0, 99999); // Para dispositivos móveis

  // Copia para a área de transferência usando a API moderna do navegador
  navigator.clipboard.writeText(campoPix.value).then(() => {
    // Feedback visual para o usuário
    const btn = document.getElementById('btn-copiar');
    const textoOriginal = btn.innerText;
    
    btn.innerText = 'Copiado!';
    btn.style.background = '#16a34a';
    btn.style.color = '#ffffff';

    // Volta ao texto original após 2 segundos
    setTimeout(() => {
      btn.innerText = textoOriginal;
      btn.style.background = '#ffffff';
      btn.style.color = 'var(--navy)';
    }, 2000);
  }).catch(err => {
    console.error('Erro ao copiar: ', err);
  });
}